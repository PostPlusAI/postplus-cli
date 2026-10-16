import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { PostPlusClientUpgradeRequiredError } from './client-compatibility.js';
import { resolveImageSequenceSource } from './generated/hosted-image-source-core.js';
import {
  inspectLocalImage,
  prepareImageSequence,
} from './media-image-download.js';
import { createImageSourceFetcher } from './media-source-http.js';
import { inspectVideoFile } from './media-video-file.js';

export async function prepareMediaSource(
  source: string,
  dependencies: {
    fetchSource?: Awaited<ReturnType<typeof createImageSourceFetcher>>;
    signal?: AbortSignal;
    onProgress?: (stage: string, bytes?: number) => void;
    parentDirectory?: string;
  } = {},
) {
  const signal = dependencies.signal ?? AbortSignal.timeout(120000);
  dependencies.onProgress?.('resolving_source');
  if (!/^https?:\/\//iu.test(source)) {
    const filename = path.resolve(source);
    if (!(await lstat(filename)).isFile())
      throw new Error('media_source_not_regular_file');
    if (/\.(?:mp4|mov|m4v|webm)$/iu.test(filename))
      return {
        kind: 'video',
        filePath: filename,
        metadata: await inspectVideoFile(filename),
      };
    return { kind: 'image', ...(await inspectLocalImage(filename)) };
  }
  let fetchSource = dependencies.fetchSource;
  const fetchImage: Awaited<
    ReturnType<typeof createImageSourceFetcher>
  > = async (...args) => {
    fetchSource ??= await createImageSourceFetcher();
    return fetchSource(...args);
  };
  const resolved = await resolveImageSequenceSource(source, fetchImage, signal);
  if (resolved.kind === 'video-input') return resolved;
  const { sequence, sourceIdentifier } = resolved;
  return prepareImageSequence({
    sequence,
    sourceIdentifier,
    signal,
    fetchImage: (href, signal) => fetchImage(href, signal),
    onProgress: dependencies.onProgress,
    parentDirectory: dependencies.parentDirectory,
  });
}

export async function runMediaPrepareCommand(
  args: string[],
  dependencies: {
    prepareVideo?: (source: string) => Promise<unknown>;
    readProductError?: (error: unknown) => Record<string, unknown> | undefined;
  } = {},
): Promise<number> {
  if (args.some((arg) => ['help', '--help', '-h'].includes(arg))) {
    console.log(
      'postplus media prepare --source <social-url-or-local-path>\nPrepare readable local evidence for your Agent. Video preparation acquires and validates the file without purchasing video inference.\nOptions: --source supplies a supported URL or local path; --help/-h shows help.\nExamples: postplus media prepare --source ./clip.mp4\nNext: Use the returned local evidence with your selected analysis workflow.',
    );
    return 0;
  }
  if (args.length !== 2 || args[0] !== '--source' || !args[1]?.trim())
    throw new Error(
      'media prepare requires --source <social-url-or-local-path>.',
    );
  const started = performance.now();
  let stage = 'resolving_source';
  let emitted: string | null = null;
  try {
    const result = await prepareMediaSource(args[1], {
      onProgress(next, bytes) {
        if (next === emitted) return;
        stage = next;
        emitted = next;
        process.stderr.write(
          `stage=${stage} elapsed=${Math.round(performance.now() - started)}ms${bytes === undefined ? '' : ` bytes=${bytes}`}\n`,
        );
      },
    });
    const prepared =
      result.kind === 'video-input' && dependencies.prepareVideo
        ? await dependencies.prepareVideo(args[1])
        : result;
    console.log(JSON.stringify(prepared, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof PostPlusClientUpgradeRequiredError) throw error;
    const productError = dependencies.readProductError?.(error);
    if (productError) {
      console.error(
        JSON.stringify({
          ...productError,
          elapsedMs: Math.round(performance.now() - started),
        }),
      );
      return 1;
    }
    const known =
      error instanceof Error &&
      /^media_(?:source|image|video)_[a-z_]+$/u.test(error.message)
        ? error.message
        : 'media_source_unavailable';
    if (
      error instanceof Error &&
      'stage' in error &&
      ['downloading_source', 'validating_media'].includes(String(error.stage))
    )
      stage = String(error.stage);
    console.error(
      JSON.stringify({
        stage,
        elapsedMs: Math.round(performance.now() - started),
        code: known,
        retryable:
          error instanceof Error &&
          'retryable' in error &&
          typeof error.retryable === 'boolean'
            ? error.retryable
            : [
                'media_source_network_failed',
                'media_source_timeout',
                'media_source_rate_limited',
              ].includes(known),
        ...(error instanceof Error &&
        'imageIndex' in error &&
        Number.isSafeInteger(error.imageIndex)
          ? { imageIndex: error.imageIndex }
          : {}),
        ...(error instanceof Error && 'partialEvidence' in error
          ? { partialEvidence: error.partialEvidence }
          : {}),
        userAction:
          (known === 'media_source_non_public_address'
            ? 'Local DNS returned a non-public address. Check DNS/Fake-IP settings and whether the configured proxy route applies. The blocked request was not sent; this does not establish that the post is unavailable.'
            : known.includes('proxy')
              ? 'Check the configured network proxy and supported Node runtime; no media was analyzed.'
              : 'Check that the source is public and readable. Resume any existing source operation; collection may have incurred charges even when preparation fails.') +
          (error instanceof Error && 'partialEvidence' in error
            ? ' Downloaded images are available in partialEvidence. Inspect them and clearly state the missing pages.'
            : ''),
      }),
    );
    return 1;
  }
}
