import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { ImageSequence } from './media-image-source.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

// Only retry before any image bytes are consumed. Keep this exact source URL
// and the already downloaded pages; never re-resolve or restart the collection.
async function fetchImageHeaders(
  fetchImage: (url: string, signal: AbortSignal) => Promise<Response>,
  url: string,
  signal: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchImage(url, signal);
      const transient =
        response.status === 429 ||
        [500, 502, 503, 504].includes(response.status);
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter === null ? 0.2 : Number(retryAfter);
      if (
        !transient ||
        attempt !== 0 ||
        !Number.isFinite(seconds) ||
        seconds < 0 ||
        seconds > 2
      )
        return response;
      await response.body?.cancel();
      await delay(Math.max(200, seconds * 1000), undefined, { signal });
    } catch (error) {
      if (
        attempt !== 0 ||
        signal.aborted ||
        !(error instanceof Error) ||
        error.message !== 'media_source_network_failed'
      )
        throw error;
      await delay(200, undefined, { signal });
    }
  }
}
function failure(code: string, stage = 'validating_media', retryable = false) {
  return Object.assign(new Error(code), { code, stage, retryable });
}

// A signature identifies a candidate format, not a decodable or static image.
// The visual Agent must open every requested image before claiming coverage.
function imageMime(header: Buffer) {
  if (header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return 'image/png';
  if (header.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')))
    return 'image/jpeg';
  if (/^GIF8[79]a$/u.test(header.toString('ascii', 0, 6))) return 'image/gif';
  if (
    header.toString('ascii', 0, 4) === 'RIFF' &&
    header.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (
    header.toString('ascii', 4, 8) === 'ftyp' &&
    /^avi[fs]$/u.test(header.toString('ascii', 8, 12))
  )
    return 'image/avif';
  throw failure('media_image_unsupported');
}

export async function inspectLocalImage(filePath: string) {
  filePath = path.resolve(filePath);
  const before = await lstat(filePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !before.size ||
    before.size > MAX_IMAGE_BYTES
  )
    throw failure('media_image_invalid_file');
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(32);
    await file.read(header, 0, header.length, 0);
    const mime = imageMime(header);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of file.createReadStream({
      start: 0,
      autoClose: false,
    })) {
      bytes += chunk.length;
      if (bytes > MAX_IMAGE_BYTES) throw failure('media_image_size_limit');
      hash.update(chunk);
    }
    const after = await file.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes !== after.size
    )
      throw failure('media_image_changed');
    return {
      filePath,
      mime,
      bytes,
      sha256: hash.digest('hex'),
      readability: 'agent-required' as const,
    };
  } finally {
    await file.close();
  }
}

export async function prepareImageSequence(input: {
  sequence: ImageSequence;
  sourceIdentifier: string;
  fetchImage: (url: string, signal: AbortSignal) => Promise<Response>;
  signal: AbortSignal;
  onProgress?: (stage: string, bytes: number) => void;
  parentDirectory?: string;
}) {
  let directory: string | undefined;
  let stage = 'validating_media';
  let imageIndex = 0;
  let pendingFilePath: string | undefined;
  let manifestWriteStarted = false;
  let manifestWritten = false;
  const manifest = {
    kind: 'ordered-images' as const,
    directory: '',
    manifestPath: '',
    sourceIdentifier: input.sourceIdentifier,
    completenessBasis: input.sequence.completenessBasis,
    declaredCount: input.sequence.declaredCount,
    readability: 'agent-required' as const,
    images: [] as {
      index: number;
      filePath: string;
      mime: string;
      sourceDimensions: { width: number | null; height: number | null };
      bytes: number;
      sha256: string;
    }[],
    totalBytes: 0,
  };
  try {
    input.signal.throwIfAborted();
    const sequence = input.sequence;
    if (
      !/^[a-z0-9][a-z0-9:._-]{0,199}$/iu.test(input.sourceIdentifier) ||
      sequence.images.length < 1 ||
      sequence.images.length > 35 ||
      !['returned-list', 'declared-count'].includes(
        sequence.completenessBasis,
      ) ||
      (sequence.completenessBasis === 'declared-count' &&
        sequence.declaredCount === null) ||
      (sequence.declaredCount !== null &&
        sequence.declaredCount !== sequence.images.length)
    )
      throw failure('media_image_sequence_invalid');
    for (const [position, image] of sequence.images.entries()) {
      const url = new URL(image.url);
      if (
        image.index !== position + 1 ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        [image.width, image.height].some(
          (n) => n !== null && (!Number.isSafeInteger(n) || n <= 0),
        )
      )
        throw failure('media_image_sequence_invalid');
    }
    directory = await mkdtemp(
      path.join(input.parentDirectory ?? tmpdir(), 'postplus-images-'),
    );
    await chmod(directory, 0o700);
    manifest.directory = directory;
    manifest.manifestPath = path.join(directory, 'manifest.json');
    for (const entry of sequence.images) {
      imageIndex = entry.index;
      input.signal.throwIfAborted();
      stage = 'downloading_source';
      input.onProgress?.(stage, manifest.totalBytes);
      const response = await fetchImageHeaders(
        input.fetchImage,
        entry.url,
        input.signal,
      );
      const length = response.headers.get('content-length');
      const declared = length === null ? null : Number(length);
      if (
        (length !== null &&
          (!/^\d+$/u.test(length) ||
            !Number.isSafeInteger(declared) ||
            declared! <= 0)) ||
        !['identity', null].includes(response.headers.get('content-encoding'))
      ) {
        await response.body?.cancel();
        throw failure('media_image_invalid_transfer', stage);
      }
      if (
        input.signal.aborted ||
        !response.ok ||
        !response.body ||
        (declared ?? 0) > MAX_IMAGE_BYTES ||
        (declared ?? 0) + manifest.totalBytes > MAX_TOTAL_BYTES
      ) {
        await response.body?.cancel();
        input.signal.throwIfAborted();
        throw failure(
          response.ok
            ? 'media_image_size_limit'
            : 'media_image_download_failed',
          stage,
          response.status === 429 || response.status >= 500,
        );
      }
      let filePath = path.join(
        directory,
        `${String(entry.index).padStart(3, '0')}.image`,
      );
      const file = await open(filePath, 'wx', 0o600);
      pendingFilePath = filePath;
      const reader = response.body.getReader();
      let bytes = 0;
      const abort = () => {
        void reader.cancel().catch(() => undefined);
      };
      input.signal.addEventListener('abort', abort, { once: true });
      try {
        while (true) {
          input.signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (
            bytes > MAX_IMAGE_BYTES ||
            manifest.totalBytes + bytes > MAX_TOTAL_BYTES
          )
            throw failure('media_image_size_limit', stage);
          await file.writeFile(chunk.value);
        }
      } finally {
        input.signal.removeEventListener('abort', abort);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        await file.close();
      }
      input.signal.throwIfAborted();
      stage = 'validating_media';
      input.onProgress?.(stage, manifest.totalBytes + bytes);
      if (!bytes || (declared !== null && declared !== bytes))
        throw failure('media_image_incomplete_download', stage, true);
      const metadata = await inspectLocalImage(filePath);
      input.signal.throwIfAborted();
      const finalPath = path.join(
        directory,
        `${String(entry.index).padStart(3, '0')}.${metadata.mime.slice('image/'.length)}`,
      );
      await rename(filePath, finalPath);
      filePath = finalPath;
      manifest.images.push({
        index: entry.index,
        filePath,
        mime: metadata.mime,
        bytes: metadata.bytes,
        sha256: metadata.sha256,
        sourceDimensions: { width: entry.width, height: entry.height },
      });
      manifest.totalBytes += bytes;
      pendingFilePath = undefined;
    }
    input.signal.throwIfAborted();
    manifestWriteStarted = true;
    await writeFile(
      manifest.manifestPath,
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    manifestWritten = true;
    input.signal.throwIfAborted();
    return manifest;
  } catch (error) {
    const originalError = input.signal.aborted
      ? failure('media_image_cancelled', stage, true)
      : error instanceof Error && /^media_source_[a-z_]+$/u.test(error.message)
        ? failure(
            error.message,
            stage,
            ['media_source_timeout', 'media_source_network_failed'].includes(
              error.message,
            ),
          )
        : error instanceof Error && /^media_image_[a-z_]+$/u.test(error.message)
          ? error
          : failure(
              stage === 'downloading_source'
                ? 'media_image_download_failed'
                : 'media_image_invalid_file',
              stage,
              stage === 'downloading_source',
            );
    const failed = Object.assign(originalError, { imageIndex });
    if (pendingFilePath) await rm(pendingFilePath, { force: true });
    if (!manifest.images.length) {
      if (directory) await rm(directory, { recursive: true, force: true });
      throw failed;
    }
    const partialEvidence = {
      ...manifest,
      status: 'partial' as const,
      failedImageIndex:
        manifest.images.length < input.sequence.images.length
          ? imageIndex
          : null,
    };
    // Retain only verified files. A manifest persistence failure must not hide
    // those files or claim a manifest exists; return the same evidence inline.
    let manifestWriteFailed = manifestWriteStarted && !manifestWritten;
    if (!manifestWriteFailed) {
      try {
        await writeFile(
          manifest.manifestPath,
          JSON.stringify(partialEvidence, null, 2) + '\n',
          { flag: manifestWritten ? 'w' : 'wx', mode: 0o600 },
        );
      } catch {
        manifestWriteFailed = true;
      }
    }
    if (manifestWriteFailed) {
      await rm(manifest.manifestPath, { force: true });
      const { manifestPath: _manifestPath, ...inlineEvidence } =
        partialEvidence;
      throw Object.assign(failed, {
        partialEvidence: {
          ...inlineEvidence,
          manifestError: 'media_image_manifest_write_failed',
        },
      });
    }
    throw Object.assign(failed, { partialEvidence });
  }
}
