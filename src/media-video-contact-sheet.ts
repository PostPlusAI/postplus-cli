import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand } from './command-runner.js';
import { PostPlusFailure } from './failure-contract.js';
import { shellQuoteArg } from './hosted-command-runtime.js';
import {
  type LocalVideoMetadata,
  inspectVideoFile,
} from './media-video-file.js';

const SCENE_THRESHOLD = 0.25;
const FRAMES_PER_SHEET = 9;
type Runner = typeof runCommand;

export type VisualFrameRange = {
  startSeconds?: number;
  endSeconds?: number;
  frameIntervalSeconds?: number;
};

export type VideoContactSheet = {
  schemaVersion: 1;
  kind: 'video-contact-sheet';
  status: 'prepared';
  analysis: 'agent-required';
  filePath: string;
  metadata: LocalVideoMetadata;
  manifestPath: string;
  sourceStartTimestampSeconds: number;
  sampling: {
    startSeconds: number;
    endSeconds: number;
    frameIntervalSeconds: number;
    sceneChangeThreshold: number;
    endingFrameIncluded: true;
  };
  frames: {
    filePath: string;
    timestampSeconds: number;
    sourceTimestampSeconds: number;
    reasons: string[];
  }[];
  contactSheets: { filePath: string; firstFrame: number; lastFrame: number }[];
  audio: 'not-inspected' | 'no-audio-stream';
  nextAction: string;
  cloudCommand: string | null;
};

export function validateVisualFrameRange(range: VisualFrameRange): void {
  for (const [key, value] of Object.entries(range)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new Error(
        `--${key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)} must be a finite non-negative number.`,
      );
  }
  if (range.frameIntervalSeconds === 0)
    throw new Error('--frame-interval-seconds must be greater than zero.');
  if (
    range.endSeconds !== undefined &&
    range.endSeconds <= (range.startSeconds ?? 0)
  )
    throw new Error('--end-seconds must be greater than --start-seconds.');
}

export async function assertContactSheetTools(
  run: Runner = runCommand,
): Promise<void> {
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-filters'], {
      timeoutMs: 10_000,
    });
    for (const filter of ['select', 'pad', 'drawtext', 'scale', 'tile']) {
      if (!new RegExp(`\\s${filter}\\s`, 'u').test(stdout))
        throw new Error(
          `The installed ffmpeg is missing the ${filter} filter.`,
        );
    }
    await run('ffprobe', ['-version'], { timeoutMs: 10_000 });
  } catch (cause) {
    throw localFailure(
      'postplus_media_contact_sheet_dependency_missing',
      cause,
      'Use postplus doctor --skill media-analysis to resolve the local ffmpeg/ffprobe requirement. Do not replace this failure with paid analysis.',
    );
  }
}

function localFailure(
  code: string,
  cause: unknown,
  action: string,
): PostPlusFailure {
  return new PostPlusFailure(
    'Local video evidence could not be prepared.',
    {
      code,
      stage: 'local_contact_sheet',
      service: 'cli',
      retryable: false,
      action,
    },
    { cause },
  );
}

// All paths are generated local files; quoting is the concat demuxer's syntax,
// never shell syntax. Native process arguments are passed without a shell.
function concatEntry(file: string): string {
  return `file '${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
}

/** Prepare visual evidence only. This function has no network or inference path. */
export async function prepareVideoContactSheet(input: {
  filePath: string;
  metadata?: LocalVideoMetadata;
  parentDirectory?: string;
  range?: VisualFrameRange;
  toolsChecked?: boolean;
  run?: Runner;
}): Promise<VideoContactSheet> {
  const run = input.run ?? runCommand;
  const range = input.range ?? {};
  validateVisualFrameRange(range);
  if (!input.toolsChecked) await assertContactSheetTools(run);
  try {
    const filePath = path.resolve(
      input.filePath.startsWith('file://')
        ? fileURLToPath(input.filePath)
        : input.filePath,
    );
    const metadata = input.metadata ?? (await inspectVideoFile(filePath, run));
    const startSeconds = range.startSeconds ?? 0;
    const frameIntervalSeconds = range.frameIntervalSeconds ?? 1;
    const parent = path.resolve(
      input.parentDirectory ?? path.join('.postplus', 'media-analysis'),
    );
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(
      path.join(parent, `${metadata.sha256.slice(0, 12)}-`),
    );
    const { stdout, stderr } = await run(
      'ffprobe',
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        filePath,
      ],
      { timeoutMs: 300_000 },
    );
    if (stderr.trim())
      throw new Error(`Video decoding reported an error: ${stderr}`);
    const probed: unknown = JSON.parse(stdout);
    if (
      !probed ||
      typeof probed !== 'object' ||
      !('frames' in probed) ||
      !Array.isArray(probed.frames)
    )
      throw new Error('The video did not return decoded frame timestamps.');
    const times = probed.frames.map((frame: unknown) => {
      const value =
        frame &&
        typeof frame === 'object' &&
        'best_effort_timestamp_time' in frame
          ? Number(frame.best_effort_timestamp_time)
          : NaN;
      if (!Number.isFinite(value))
        throw new Error('A decoded video frame has no presentation timestamp.');
      return value;
    });
    if (!times.length) throw new Error('The video has no decoded frames.');
    const sourceStart = times[0]!;
    const endSeconds = range.endSeconds ?? times.at(-1)! - sourceStart;
    const inRange = times
      .map((time, index) => ({ time, index, elapsed: time - sourceStart }))
      .filter(
        (frame) =>
          frame.elapsed >= startSeconds - 0.000001 &&
          frame.elapsed <= endSeconds + 0.000001,
      );
    if (!inRange.length)
      throw new Error('The requested interval contains no decoded frames.');
    const first = inRange[0]!;
    const last = inRange.at(-1)!;
    const byMicros = new Map<number, typeof first>();
    for (let i = 0; i < times.length; i++) {
      const time = times[i]!;
      const micros = Math.round(time * 1_000_000);
      if (byMicros.has(micros) || (i > 0 && time <= times[i - 1]!))
        throw new Error(
          'Local evidence requires distinct, increasing decoded frame timestamps.',
        );
      byMicros.set(micros, { time, index: i, elapsed: time - sourceStart });
    }
    // Cadence depends on the previous INPUT frame, not the previous selected
    // frame: adding a scene candidate must never move the one-second samples.
    const cadence = `gt(floor((t-(${sourceStart + startSeconds}))/${frameIntervalSeconds}),floor((prev_t-(${sourceStart + startSeconds}))/${frameIntervalSeconds}))`;
    const select = `between(n,${first.index},${last.index})*(eq(n,${first.index})+${cadence}+gt(scene,${SCENE_THRESHOLD})+eq(n,${last.index}))`;
    const framesDirectory = path.join(directory, 'frames');
    await mkdir(framesDirectory);
    const extracted = await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-n',
        '-copyts',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        filePath,
        '-map',
        '0:v:0',
        '-an',
        '-vf',
        `select='${select}',pad=iw:ih+ceil(iw/12):0:0:black,drawtext=text='%{pts\\:hms}':fontsize=w/24:fontcolor=white:x=10:y=h-th-8`,
        '-fps_mode',
        'passthrough',
        '-enc_time_base',
        '1:1000000',
        '-frame_pts',
        '1',
        '-q:v',
        '2',
        path.join(framesDirectory, 'frame-%016d.jpg'),
      ],
      { timeoutMs: 300_000 },
    );
    if (extracted.stderr.trim())
      throw new Error(
        `Frame extraction reported an error: ${extracted.stderr}`,
      );
    const selected = (await readdir(framesDirectory))
      .map((name) => {
        const match = /^frame-(-?\d+)\.jpg$/u.exec(name);
        if (!match)
          throw new Error('The frame extractor returned an unexpected file.');
        const micros = Number(match[1]);
        const original = byMicros.get(micros);
        if (
          !original ||
          original.index < first.index ||
          original.index > last.index
        )
          throw new Error(
            'Extracted frame timestamp does not match the decoded source.',
          );
        return { ...original, filePath: path.join(framesDirectory, name) };
      })
      .sort((a, b) => a.index - b.index);
    if (
      selected[0]?.index !== first.index ||
      selected.at(-1)?.index !== last.index
    )
      throw new Error(
        'The extracted evidence is missing the first or ending frame.',
      );
    const frames = selected.map((frame) => {
      const prior = times[frame.index - 1];
      const cadenceFrame =
        frame.index === first.index ||
        (prior !== undefined &&
          Math.floor(
            (frame.time - sourceStart - startSeconds) / frameIntervalSeconds,
          ) >
            Math.floor(
              (prior - sourceStart - startSeconds) / frameIntervalSeconds,
            ));
      return {
        filePath: frame.filePath,
        timestampSeconds: Number(frame.elapsed.toFixed(6)),
        sourceTimestampSeconds: frame.time,
        reasons: [
          ...(cadenceFrame ? ['interval'] : []),
          ...(!cadenceFrame && frame.index !== last.index
            ? ['scene-change-candidate']
            : []),
          ...(frame.index === last.index ? ['ending'] : []),
        ],
      };
    });
    const list = path.join(directory, 'frames.concat');
    await writeFile(
      list,
      frames.map((frame) => concatEntry(frame.filePath)).join('\n') + '\n',
    );
    const tiled = await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-n',
        '-protocol_whitelist',
        'file,pipe',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-an',
        '-vf',
        `scale=360:-2,tile=3x3:nb_frames=${FRAMES_PER_SHEET}:padding=6:margin=6:color=black`,
        '-fps_mode',
        'passthrough',
        '-q:v',
        '2',
        path.join(directory, 'contact-sheet-%04d.jpg'),
      ],
      { timeoutMs: 300_000 },
    );
    if (tiled.stderr.trim())
      throw new Error(
        `Contact-sheet rendering reported an error: ${tiled.stderr}`,
      );
    const sheets = (await readdir(directory))
      .filter((name) => /^contact-sheet-\d+\.jpg$/u.test(name))
      .sort();
    if (sheets.length !== Math.ceil(frames.length / FRAMES_PER_SHEET))
      throw new Error(
        'The contact sheets do not cover the extracted frame set.',
      );
    const manifestPath = path.join(directory, 'contact-sheet.json');
    const result: VideoContactSheet = {
      schemaVersion: 1,
      kind: 'video-contact-sheet',
      status: 'prepared',
      analysis: 'agent-required',
      filePath,
      metadata,
      manifestPath,
      sourceStartTimestampSeconds: sourceStart,
      sampling: {
        startSeconds,
        endSeconds,
        frameIntervalSeconds,
        sceneChangeThreshold: SCENE_THRESHOLD,
        endingFrameIncluded: true,
      },
      frames,
      contactSheets: sheets.map((name, index) => ({
        filePath: path.join(directory, name),
        firstFrame: index * FRAMES_PER_SHEET + 1,
        lastFrame: Math.min((index + 1) * FRAMES_PER_SHEET, frames.length),
      })),
      audio: metadata.hasAudio ? 'not-inspected' : 'no-audio-stream',
      nextAction:
        'Inspect the contact sheets and full-size frames. Refine visual gaps locally with --start-seconds, --end-seconds and --frame-interval-seconds. Use --cloud only when important spoken content needed for the answer cannot be determined from subtitles. A prepared sheet is not a completed analysis; scene candidates do not prove every cut was found. Labels show source presentation time; timestampSeconds is elapsed video time.',
      cloudCommand: metadata.hasAudio
        ? `postplus media analyze video-analysis --video ${shellQuoteArg(filePath)} --cloud --output ${shellQuoteArg(path.join(directory, 'cloud-analysis.md'))}`
        : null,
    };
    await writeFile(manifestPath, JSON.stringify(result, null, 2) + '\n', {
      mode: 0o600,
    });
    return result;
  } catch (cause) {
    if (cause instanceof PostPlusFailure) throw cause;
    throw localFailure(
      'postplus_media_contact_sheet_failed',
      cause,
      'Review the local video/frame error and keep any prepared evidence. Do not submit cloud analysis to bypass a failed local preparation.',
    );
  }
}
