/** Video text rendering SSOT. Cloud code and font assets are generated from this module. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const VIDEO_TEXT_LIMITS = {
  maxSeconds: 120,
  maxPixels: 2073600,
  maxBytes: 100 * 1024 * 1024,
  timeoutMs: 180000,
};
export const VIDEO_TEXT_FONTS = ['Arimo', 'Noto Sans SC'] as const;
export type TextStyle = {
  fontFamily: (typeof VIDEO_TEXT_FONTS)[number];
  fontSize: number;
  bold: boolean;
  color: string;
  outlineColor: string;
  outline: number;
  shadow: number;
  alignment: number;
  marginLeft: number;
  marginRight: number;
  marginVertical: number;
  backgroundColor?: string;
};
export type TextCue = {
  start: number;
  end: number;
  text: string;
  fadeInMs: number;
  fadeOutMs: number;
};
export type VideoTextPlan = {
  schemaVersion: 1;
  width: number;
  height: number;
  captionStyle: TextStyle;
  captions: TextCue[];
  overlays: (TextCue & { style: TextStyle })[];
};
type Spec = {
  type?: string;
  properties?: Record<string, Spec>;
  required?: readonly string[];
  items?: Spec;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  description?: string;
  additionalProperties?: false;
};
const number = (
  minimum: number,
  maximum: number,
  defaultValue?: number,
): Spec => ({
  type: 'number',
  minimum,
  maximum,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
});
const styleProperties: Record<string, Spec> = {
  fontFamily: { type: 'string', enum: VIDEO_TEXT_FONTS, default: 'Arimo' },
  fontSize: number(8, 240, 36),
  bold: { type: 'boolean', default: true },
  color: {
    type: 'string',
    default: '#FFFFFF',
    description: '#RRGGBB or #RRGGBBAA',
  },
  outlineColor: { type: 'string', default: '#303030' },
  outline: number(0, 12, 1.2),
  shadow: number(0, 12, 0.5),
  alignment: {
    type: 'integer',
    minimum: 1,
    maximum: 9,
    default: 2,
    description:
      'ASS anchor: 1/2/3 bottom, 4/5/6 middle, 7/8/9 top; left/center/right.',
  },
  marginLeft: number(0, 3840, 48),
  marginRight: number(0, 3840, 48),
  marginVertical: number(0, 3840, 300),
  backgroundColor: {
    type: 'string',
    description:
      'Optional solid text box, #RRGGBB or #RRGGBBAA; outline becomes box padding.',
  },
};
const style = (defaults: object = {}): Spec => ({
  type: 'object',
  additionalProperties: false,
  properties: styleProperties,
  default: defaults,
});
const cueProperties: Record<string, Spec> = {
  start: number(0, VIDEO_TEXT_LIMITS.maxSeconds),
  end: number(0, VIDEO_TEXT_LIMITS.maxSeconds),
  text: {
    type: 'string',
    minLength: 1,
    maxLength: 2000,
    description:
      'Literal text. Use real newline characters for chosen line breaks; no ASS tags.',
  },
  fadeInMs: number(0, 1000, 0),
  fadeOutMs: number(0, 1000, 0),
};
export const VIDEO_TEXT_PLAN_SCHEMA: Spec = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'width', 'height'],
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    width: { type: 'integer', minimum: 32, maximum: 3840 },
    height: { type: 'integer', minimum: 32, maximum: 3840 },
    captionStyle: style(),
    captions: {
      type: 'array',
      maxItems: 1000,
      default: [],
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'text'],
        properties: cueProperties,
      },
    },
    overlays: {
      type: 'array',
      maxItems: 100,
      default: [],
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'text'],
        properties: {
          ...cueProperties,
          style: style({
            fontSize: 43,
            alignment: 8,
            marginVertical: 95,
            outline: 1.8,
          }),
        },
      },
    },
  },
};
export function normalizeFromSchema(
  value: unknown,
  schema: Spec,
  location = 'plan',
): unknown {
  if (value === undefined) {
    if (schema.default === undefined) return undefined;
    value = structuredClone(schema.default);
  }
  const fail = (message: string): never => {
    throw new Error(location + ': ' + message);
  };
  if (schema.enum && !schema.enum.includes(value)) fail('unsupported value');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail('expected object');
    const object = {
      ...((schema.default as object) ?? {}),
      ...(value as object),
    } as Record<string, unknown>;
    const properties = schema.properties!;
    for (const key of Object.keys(object))
      if (!(key in properties)) fail('unknown field ' + key);
    for (const key of schema.required ?? [])
      if (object[key] === undefined) fail('missing ' + key);
    const output: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(properties)) {
      const normalized = normalizeFromSchema(
        object[key],
        spec,
        location + '.' + key,
      );
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('expected array');
    const items = value as unknown[];
    if (
      items.length < (schema.minItems ?? 0) ||
      items.length > (schema.maxItems ?? Infinity)
    )
      fail('array size outside limits');
    return items.map((item, index) =>
      normalizeFromSchema(item, schema.items!, location + '[' + index + ']'),
    );
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') fail('expected string');
    if (
      (value as string).length < (schema.minLength ?? 0) ||
      (value as string).length > (schema.maxLength ?? Infinity)
    )
      fail('text length outside limits');
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail('expected boolean');
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isInteger(value))
    )
      fail('expected finite ' + schema.type);
    if (
      (value as number) < (schema.minimum ?? -Infinity) ||
      (value as number) > (schema.maximum ?? Infinity)
    )
      fail('number outside limits');
  } else fail('unsupported schema type');
  return value;
}
export function parseVideoTextPlan(raw: unknown): VideoTextPlan {
  const plan = normalizeFromSchema(
    raw,
    VIDEO_TEXT_PLAN_SCHEMA,
  ) as VideoTextPlan;
  if (
    plan.width % 2 ||
    plan.height % 2 ||
    plan.width * plan.height > VIDEO_TEXT_LIMITS.maxPixels
  )
    throw Error(
      'Plan canvas must have even dimensions and fit 1080p pixel count.',
    );
  if (!plan.captions.length && !plan.overlays.length)
    throw Error('Add at least one caption or overlay.');
  for (const item of [...plan.captions, ...plan.overlays]) {
    if (
      item.end <= item.start ||
      Math.round(item.end * 100) <= Math.round(item.start * 100)
    )
      throw Error('Text must have a positive duration at ASS precision.');
    if (item.fadeInMs + item.fadeOutMs > (item.end - item.start) * 1000)
      throw Error('Text fades exceed the cue duration.');
    if (
      !item.text.trim() ||
      /[\\{}\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(item.text)
    )
      throw Error(
        'Text contains unsupported control characters or ASS markup.',
      );
  }
  for (const entry of [
    plan.captionStyle,
    ...plan.overlays.map((item) => item.style),
  ]) {
    for (const color of [
      entry.color,
      entry.outlineColor,
      entry.backgroundColor,
    ].filter(Boolean))
      if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color!))
        throw Error('Colors must use #RRGGBB or #RRGGBBAA.');
    if (
      entry.marginLeft + entry.marginRight >= plan.width ||
      entry.marginVertical >= plan.height ||
      entry.fontSize > plan.height / 3
    )
      throw Error('Text layout exceeds the canvas.');
  }
  return plan;
}
function assColor(hex: string) {
  const value = hex.slice(1),
    opacity = value.length === 8 ? parseInt(value.slice(6), 16) : 255;
  return (
    '&H' +
    (255 - opacity).toString(16).padStart(2, '0') +
    value.slice(4, 6) +
    value.slice(2, 4) +
    value.slice(0, 2)
  );
}
function assTime(value: number) {
  const n = Math.round(value * 100);
  return (
    Math.floor(n / 360000) +
    ':' +
    String(Math.floor(n / 6000) % 60).padStart(2, '0') +
    ':' +
    String(Math.floor(n / 100) % 60).padStart(2, '0') +
    '.' +
    String(n % 100).padStart(2, '0')
  );
}
export function compileVideoTextAss(raw: unknown): {
  plan: VideoTextPlan;
  ass: string;
} {
  const plan = parseVideoTextPlan(raw);
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: ' + plan.width,
    'PlayResY: ' + plan.height,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  ];
  const writeStyle = (name: string, s: TextStyle) =>
    lines.push(
      'Style: ' +
        [
          name,
          s.fontFamily,
          s.fontSize,
          assColor(s.color),
          assColor(s.color),
          assColor(s.backgroundColor ?? s.outlineColor),
          '&H80000000',
          s.bold ? -1 : 0,
          0,
          0,
          0,
          100,
          100,
          0,
          0,
          s.backgroundColor ? 3 : 1,
          s.outline,
          s.shadow,
          s.alignment,
          s.marginLeft,
          s.marginRight,
          s.marginVertical,
          1,
        ].join(','),
    );
  writeStyle('Caption', plan.captionStyle);
  plan.overlays.forEach((item, i) => writeStyle('Overlay' + i, item.style));
  lines.push(
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  );
  const event = (cue: TextCue, name: string, layer: number) => {
    const fades =
      cue.fadeInMs || cue.fadeOutMs
        ? '{\\fad(' +
          Math.round(cue.fadeInMs) +
          ',' +
          Math.round(cue.fadeOutMs) +
          ')}'
        : '';
    lines.push(
      'Dialogue: ' +
        [
          layer,
          assTime(cue.start),
          assTime(cue.end),
          name,
          '',
          0,
          0,
          0,
          '',
          fades + cue.text.replace(/\r?\n/g, '\\N'),
        ].join(','),
    );
  };
  plan.captions.forEach((cue) => event(cue, 'Caption', 1));
  plan.overlays.forEach((cue, index) => event(cue, 'Overlay' + index, 2));
  return { plan, ass: lines.join('\n') + '\n' };
}
export async function videoTextFileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function command(
  executable: string,
  args: string[],
  signal: AbortSignal,
  env: Record<string, string | undefined> = {},
) {
  signal.throwIfAborted();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        NODE_ENV: 'production',
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        ...env,
      },
    });
    let stdout = '',
      stderr = '',
      failure: Error | undefined;
    const abort = () => {
      failure = Error('video_text_render_deadline_exceeded');
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024) abort();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 1024 * 1024) abort();
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (failure || code !== 0)
        reject(
          failure ?? Error('Video encoder failed: ' + stderr.slice(-3000)),
        );
      else resolve({ stdout, stderr });
    });
  });
}
export async function probeVideoTextSource(
  input: string,
  executable = 'ffprobe',
  signal = AbortSignal.timeout(15000),
) {
  const result = await command(
    executable,
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
      '-format_whitelist',
      'mov,matroska,webm',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      path.resolve(input),
    ],
    signal,
  );
  const data = JSON.parse(result.stdout),
    video = data.streams?.find(
      (item: { codec_type: string }) => item.codec_type === 'video',
    );
  const duration = Number(data.format?.duration);
  if (
    !video ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > VIDEO_TEXT_LIMITS.maxSeconds
  )
    throw Error('Video must have a known duration of at most 120 seconds.');
  const rotation = Number(
    video.tags?.rotate ??
      video.side_data_list?.find(
        (item: { rotation?: number }) => item.rotation !== undefined,
      )?.rotation ??
      0,
  );
  const swap = Math.abs(rotation % 180) === 90;
  const width = Number(swap ? video.height : video.width),
    height = Number(swap ? video.width : video.height);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 32 ||
    height < 32 ||
    width * height > VIDEO_TEXT_LIMITS.maxPixels
  )
    throw Error('Video exceeds the 1080p pixel limit.');
  return {
    width,
    height,
    durationSeconds: duration,
    audioStreams: data.streams.filter(
      (item: { codec_type: string }) => item.codec_type === 'audio',
    ).length as number,
  };
}
function filterPath(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "'\\''");
}
function xml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}
export async function renderVideoText(input: {
  videoPath: string;
  outputPath: string;
  plan: unknown;
  fontsDirectory: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  signal?: AbortSignal;
}) {
  const started = Date.now(),
    { plan, ass } = compileVideoTextAss(input.plan);
  const source = path.resolve(input.videoPath),
    output = path.resolve(input.outputPath);
  if (source === output || !output.toLowerCase().endsWith('.mp4'))
    throw Error('Output must be a new .mp4 file, distinct from raw.');
  const size = (await stat(source)).size;
  if (!size || size > VIDEO_TEXT_LIMITS.maxBytes)
    throw Error('Video must be at most 100 MiB.');
  const signal = input.signal
    ? AbortSignal.any([
        input.signal,
        AbortSignal.timeout(VIDEO_TEXT_LIMITS.timeoutMs),
      ])
    : AbortSignal.timeout(VIDEO_TEXT_LIMITS.timeoutMs);
  const metadata = await probeVideoTextSource(
    source,
    input.ffprobePath,
    signal,
  );
  if (metadata.width !== plan.width || metadata.height !== plan.height)
    throw Error('Plan canvas must match the displayed source dimensions.');
  if (
    [...plan.captions, ...plan.overlays].some(
      (cue) => cue.end > metadata.durationSeconds + 0.01,
    )
  )
    throw Error('Text extends beyond the source video.');
  const fonts = JSON.parse(
    await readFile(path.join(input.fontsDirectory, 'manifest.json'), 'utf8'),
  ) as { fonts: { family: string; file: string; sha256: string }[] };
  for (const font of fonts.fonts)
    if (
      !/^[A-Za-z0-9.-]+$/.test(font.file) ||
      (await videoTextFileHash(path.join(input.fontsDirectory, font.file))) !==
        font.sha256
    )
      throw Error('Bundled font integrity check failed.');
  for (const family of [
    plan.captionStyle.fontFamily,
    ...plan.overlays.map((cue) => cue.style.fontFamily),
  ])
    if (!fonts.fonts.some((font) => font.family === family))
      throw Error('Requested bundled font is unavailable.');
  const dir = await mkdtemp(path.join(tmpdir(), 'postplus-video-text-')),
    owned: string[] = [];
  try {
    const assPath = path.join(dir, 'text.ass'),
      fontConfig = path.join(dir, 'fonts.conf'),
      encoded = path.join(dir, 'encoded.mp4');
    await writeFile(assPath, ass);
    await writeFile(
      fontConfig,
      '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>' +
        xml(path.resolve(input.fontsDirectory)) +
        '</dir><cachedir>' +
        xml(dir) +
        '</cachedir></fontconfig>',
    );
    const rendered = await command(
      input.ffmpegPath ?? 'ffmpeg',
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'info',
        '-n',
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        'mov,matroska,webm',
        '-i',
        source,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-sn',
        '-dn',
        '-filter_threads',
        '1',
        '-vf',
        "ass=filename='" +
          filterPath(assPath) +
          "':fontsdir='" +
          filterPath(path.resolve(input.fontsDirectory)) +
          "'",
        '-c:v',
        'libx264',
        '-crf',
        '19',
        '-preset',
        'fast',
        '-threads',
        '2',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'copy',
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-metadata:s:v:0',
        'rotate=0',
        '-movflags',
        '+faststart',
        encoded,
      ],
      signal,
      { FONTCONFIG_FILE: fontConfig },
    );
    if (
      /failed to find|failed to load font|fontselect:.*failed|Glyph.*not found/i.test(
        rendered.stderr,
      )
    )
      throw Error('Bundled fonts could not render the requested text.');
    const resultMetadata = await probeVideoTextSource(
      encoded,
      input.ffprobePath,
      signal,
    );
    if (
      Math.abs(resultMetadata.durationSeconds - metadata.durationSeconds) >
        0.12 ||
      resultMetadata.width !== plan.width ||
      resultMetadata.height !== plan.height ||
      resultMetadata.audioStreams !== metadata.audioStreams
    )
      throw Error(
        'Encoded video does not retain the source duration, dimensions or audio streams.',
      );
    if ((await stat(encoded)).size > VIDEO_TEXT_LIMITS.maxBytes)
      throw Error('Encoded output exceeds 100 MiB.');
    const sourceSha256 = await videoTextFileHash(source),
      outputSha256 = await videoTextFileHash(encoded);
    const receipt = {
      renderer: 'postplus-video-text/v1',
      inferencePerformed: false,
      sourceSha256,
      outputSha256,
      source: source,
      output,
      metadata,
      fonts: fonts.fonts,
      fontSelections: rendered.stderr
        .split('\n')
        .filter((line) => line.includes('fontselect:')),
      encoding: { video: 'libx264', crf: 19, preset: 'fast', audio: 'copy' },
      elapsedMs: Date.now() - started,
    };
    const files: [string, string | Buffer][] = [
      [output + '.plan.json', JSON.stringify(plan, null, 2) + '\n'],
      [output + '.ass', ass],
      [output + '.render.json', JSON.stringify(receipt, null, 2) + '\n'],
      [output, await readFile(encoded)],
    ];
    for (const [file, bytes] of files) {
      const handle = await open(file, 'wx');
      owned.push(file);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    }
    return {
      ...receipt,
      planPath: output + '.plan.json',
      assPath: output + '.ass',
      receiptPath: output + '.render.json',
    };
  } catch (error) {
    await Promise.all(owned.map((file) => rm(file, { force: true })));
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
