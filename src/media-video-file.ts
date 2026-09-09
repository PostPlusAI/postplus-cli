import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { runCommand } from './command-runner.js';
import {
  fetchWithNetworkDiagnostics,
  formatNetworkErrorChain,
} from './network-diagnostics.js';

export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
type CommandRunner = typeof runCommand;
export type LocalVideoMetadata = {
  audioCodec: string | null;
  bytes: number;
  container: string;
  durationSeconds: number;
  hasAudio: boolean;
  hasVideo: true;
  height: number | null;
  mimeType: string;
  sha256: string;
  videoCodec: string;
  width: number | null;
};

const httpsUrl = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('media_video_invalid_download_url');
  return url.href;
};

/** Recognize the provider's explicit HTML redirect, without executing scripts. */
export function readMediaRefreshTarget(html: string, base: string): string {
  const targets: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    const attributes = new Map<string, string>();
    for (const attribute of tag.matchAll(
      /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu,
    ))
      attributes.set(
        attribute[1]!.toLowerCase(),
        attribute[2] ?? attribute[3] ?? attribute[4]!,
      );
    if (attributes.get('http-equiv')?.toLowerCase() !== 'refresh') continue;
    const target = /^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.+?)\s*$/iu.exec(
      attributes.get('content') ?? '',
    )?.[1];
    if (target)
      targets.push(
        httpsUrl(
          new URL(
            target.replace(/^['"]|['"]$/gu, '').replace(/&amp;/giu, '&'),
            base,
          ).href,
        ),
      );
  }
  if (targets.length !== 1)
    throw new Error('media_video_html_without_media_redirect');
  return targets[0]!;
}

export async function downloadVideoBytes(
  sourceUrl: string,
  outputPath: string,
  dependencies: {
    fetchResponse?: (url: string, signal: AbortSignal) => Promise<Response>;
    signal?: AbortSignal;
  } = {},
) {
  const signal = dependencies.signal ?? AbortSignal.timeout(120_000);
  const fetchResponse =
    dependencies.fetchResponse ??
    ((url, signal) =>
      fetchWithNetworkDiagnostics(
        url,
        { signal },
        { label: 'media-download', redirectPolicy: 'follow-https' },
      ));
  const { response, url, body } = await fetchVideoDownloadResponse(sourceUrl, signal, fetchResponse);
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > VIDEO_MAX_BYTES) {
    await body.cancel();
    throw new Error('media_video_too_large');
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${randomUUID()}.part`;
  let bytes = 0;
  try {
    await pipeline(
      Readable.fromWeb(
        body as import('node:stream/web').ReadableStream,
      ),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > VIDEO_MAX_BYTES
              ? new Error('media_video_too_large')
              : null,
            chunk,
          );
        },
      }),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (!bytes || (declaredSize > 0 && declaredSize !== bytes))
      throw new Error('media_video_download_incomplete');
    await rename(temporary, outputPath);
    return bytes;
  } catch (error) {
    if (
      error instanceof Error &&
      /^media_video_[a-z_]+$/u.test(error.message)
    )
      throw error;
    throw Object.assign(
      new Error(
        `Media download failed (stage=stream-bytes, host=${new URL(url).host}): ${formatNetworkErrorChain(error)}. Retry the same operation to continue.`,
      ),
      {
        code: 'postplus_cli_hosted_media_download_failed',
        stage: 'stream-bytes',
      },
    );
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function fetchVideoDownloadResponse(
  sourceUrl: string,
  signal: AbortSignal,
  fetchResponse: (url: string, signal: AbortSignal) => Promise<Response>,
) {
  let url = httpsUrl(sourceUrl);
  const visited = new Set<string>();
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (visited.has(url)) throw new Error('media_video_redirect_loop');
    visited.add(url);
    const response = await fetchResponse(url, signal);
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`media_video_download_http_${response.status}`);
    }
    const mime = response.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (mime === 'text/html' || mime === 'application/xhtml+xml') {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 64 * 1024)
          throw new Error('media_video_redirect_page_too_large');
        chunks.push(chunk);
      }
      url = readMediaRefreshTarget(
        Buffer.concat(chunks).toString('utf8'),
        response.url || url,
      );
      continue;
    }
    return { response, url, body: response.body };
  }
  throw new Error('media_video_redirect_limit');
}


async function probe(filePath: string, run: CommandRunner) {
  const { stdout } = await run(
    'ffprobe',
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      path.resolve(filePath),
    ],
    { timeoutMs: 30_000 },
  );
  const value: unknown = JSON.parse(stdout);
  if (
    !value ||
    typeof value !== 'object' ||
    !('streams' in value) ||
    !Array.isArray(value.streams) ||
    !('format' in value) ||
    !value.format ||
    typeof value.format !== 'object'
  )
    throw new Error('media_video_invalid_probe_result');
  return {
    streams: value.streams as Record<string, unknown>[],
    format: value.format as Record<string, unknown>,
  };
}

export async function inspectVideoFile(
  filePath: string,
  run: CommandRunner = runCommand,
): Promise<LocalVideoMetadata> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0 || info.size > VIDEO_MAX_BYTES)
    throw new Error('media_video_invalid_file_size');
  const { streams, format } = await probe(filePath, run);
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const duration = Number(format.duration);
  const container = String(format.format_name ?? '');
  const mimeType = /(?:^|,)(?:mov|mp4)(?:,|$)/u.test(container)
    ? 'video/mp4'
    : /(?:^|,)(?:matroska|webm)(?:,|$)/u.test(container)
      ? 'video/webm'
      : null;
  if (
    !video ||
    typeof video.codec_name !== 'string' ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !mimeType
  )
    throw new Error('media_video_not_decodable_video');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return {
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : null,
    bytes: info.size,
    container,
    durationSeconds: duration,
    hasAudio: Boolean(audio),
    hasVideo: true,
    height: typeof video.height === 'number' ? video.height : null,
    mimeType,
    sha256: hash.digest('hex'),
    videoCodec: video.codec_name,
    width: typeof video.width === 'number' ? video.width : null,
  };
}

export async function prepareDownloadedVideo(input: {
  url: string;
  audioUrl?: string;
  directory: string;
  dependencies?: Parameters<typeof downloadVideoBytes>[2] & {
    run?: CommandRunner;
  };
}) {
  const run = input.dependencies?.run ?? runCommand;
  const videoPath = path.join(input.directory, 'video.mp4');
  await downloadVideoBytes(input.url, videoPath, input.dependencies);
  let metadata = await inspectVideoFile(videoPath, run);
  if (!input.audioUrl) return { filePath: videoPath, metadata };
  const audioPath = path.join(input.directory, 'audio.m4a');
  await downloadVideoBytes(input.audioUrl, audioPath, input.dependencies);
  const audio = await probe(audioPath, run);
  if (!audio.streams.some((stream) => stream.codec_type === 'audio'))
    throw new Error('media_video_missing_expected_audio');
  const filePath = path.join(input.directory, 'source.mp4');
  const temporary = path.join(input.directory, `.merge-${randomUUID()}.mp4`);
  try {
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-n',
        '-i',
        videoPath,
        '-i',
        audioPath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c',
        'copy',
        temporary,
      ],
      { timeoutMs: 120_000 },
    );
    const merged = await inspectVideoFile(temporary, run);
    if (
      !merged.hasAudio ||
      merged.durationSeconds + 0.1 < metadata.durationSeconds
    )
      throw new Error('media_video_merge_incomplete');
    await rename(temporary, filePath);
    metadata = merged;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }

  return { filePath, metadata };
}
