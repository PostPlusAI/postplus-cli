import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VIDEO_UPLOAD_TIMEOUT_MS } from './generated/hosted-execution-manifest.generated.js';
import {
  type LocalVideoMetadata,
  inspectVideoFile,
  prepareDownloadedVideo,
} from './media-video-file.js';
import {
  PostPlusNetworkRequestError,
  fetchWithNetworkDiagnostics,
} from './network-diagnostics.js';

type SourceResult = {
  status?: string;
  source?: {
    kind?: string;
    videoCandidates?: { url: string; audioUrl?: string }[];
  };
  handle?: string | null;
  billing?: unknown;
  sourceOperationId?: string;
  error?: { code?: string; message?: string };
};
export type VideoSourceFailure = {
  status: 'failed' | 'canceled';
  error?: { code?: string; message?: string };
  sourceOperationId?: string;
  billing?: unknown;
};
export type VideoTransferState = {
  source: string;
  phase:
    | 'initial'
    | 'source-pending'
    | 'downloading'
    | 'downloaded'
    | 'upload-preparing'
    | 'upload-ready'
    | 'uploading'
    | 'uploaded';
  filePath?: string;
  metadata?: LocalVideoMetadata;
  sourceSubmissionAttempted?: boolean;
  sourceResult?: SourceResult;
  sourceHandle?: string;
  uploadPreparationAttempts?: number;
  uploadUrl?: string;
  uploadToken?: string;
  expiresAt?: number;
  fileName?: string;
};
export type VideoTransferRequest = {
  operation:
    | 'resolve-source'
    | 'source-status'
    | 'prepare-upload'
    | 'recover-upload';
  operationId: string;
  input: {
    source?: string;
    handle?: string;
    metadata?: LocalVideoMetadata;
    uploadToken?: string;
  };
};
type UploadFetch = (
  url: string,
  init: RequestInit & { duplex?: 'half' },
) => Promise<Response>;
export type PrepareVideoAnalysisInputOptions = {
  source: string;
  operationId: string;
  directory: string;
  state?: VideoTransferState;
  downloadOnly?: boolean;
  /** The outer checkpoint owner must persist this credential-bearing state with mode 0600. */
  saveState(state: VideoTransferState): Promise<void>;
  request(body: VideoTransferRequest): Promise<unknown>;
  onProgress?(message: string): void;
  /** The outer HTTP boundary recognizes its product/quote classes without a circular import. */
  isHostedRequestError?(error: unknown): boolean;
  /** The outer compatibility boundary proves that this request never executed. */
  isRequestRejectedBeforeExecution?(error: unknown): boolean;
  /** Trust only an outer-boundary guarantee that this source submission never occurred. */
  isSourceSubmissionRejected?(error: unknown): boolean;
  /** Produce an existing product error using the outer boundary's public-message policy. */
  sourceFailureError?(failure: VideoSourceFailure): Error;
  dependencies?: {
    fetchResponse?: UploadFetch;
    download?: typeof prepareDownloadedVideo;
    inspect?: typeof inspectVideoFile;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    waitTimeoutMs?: number;
    pollIntervalMs?: number;
  };
};
export class VideoTransferError extends Error {
  constructor(
    public readonly code: string,
    public readonly recoverable = false,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'VideoTransferError';
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const output = (value: unknown) => {
  const body = record(value);
  return record(body.output ?? body);
};
function uploadAddress(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'generativelanguage.googleapis.com' ||
    url.username ||
    url.password
  )
    throw new VideoTransferError('media_video_invalid_upload_session');
  return url.href;
}
function fileNameFrom(value: unknown) {
  const name = record(record(value).file).name;
  return typeof name === 'string' && /^files\/[a-zA-Z0-9_-]+$/u.test(name)
    ? name
    : undefined;
}

/** Download once, keep evidence locally, and send bytes to the existing Google upload session. */
export async function prepareVideoAnalysisInput(
  options: PrepareVideoAnalysisInputOptions,
) {
  const { source, operationId, dependencies = {} } = options;
  if (/^data:/iu.test(source))
    throw new VideoTransferError('media_video_unsupported_source');
  if (options.state && options.state.source !== source)
    throw new VideoTransferError('media_video_checkpoint_source_mismatch');
  const state: VideoTransferState = structuredClone(
    options.state ?? { source, phase: 'initial' },
  );
  const save = () => options.saveState(structuredClone(state));
  const inspect = dependencies.inspect ?? inspectVideoFile;
  const now = dependencies.now ?? Date.now;
  const fetchResponse: UploadFetch =
    dependencies.fetchResponse ??
    ((url, init) =>
      fetchWithNetworkDiagnostics(url, init, {
        label: 'media-video-upload',
        redirectPolicy: 'error',
      }));
  const deadline = now() + (dependencies.waitTimeoutMs ?? 120_000);
  const sleep =
    dependencies.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const progress = (message: string) => options.onProgress?.(message);

  if (!state.filePath || !state.metadata) {
    const isOwnedReference = source.startsWith('postplus-media://');
    const isRemote = /^https:\/\//iu.test(source) || isOwnedReference;
    if (
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(source) &&
      !isRemote &&
      !source.startsWith('file://')
    )
      throw new VideoTransferError('media_video_unsupported_source');
    if (!isRemote) {
      state.filePath = path.resolve(
        source.startsWith('file://') ? fileURLToPath(source) : source,
      );
      state.metadata = await inspect(state.filePath);
    } else {
      const url = new URL(source);
      if (url.username || url.password)
        throw new VideoTransferError('media_video_unsupported_source');
      let candidate: { url: string; audioUrl?: string };
      if (!isOwnedReference && /\.(?:mp4|webm|mov)$/iu.test(url.pathname))
        candidate = { url: source };
      else {
        while (state.sourceResult?.status !== 'completed') {
          const operation = state.sourceSubmissionAttempted
            ? 'source-status'
            : 'resolve-source';
          state.sourceSubmissionAttempted = true;
          state.phase = 'source-pending';
          await save();
          progress('Resolving the source video.');
          let response: unknown;
          try {
            response = await options.request({
              operation,
              operationId,
              input: {
                source,
                ...(state.sourceHandle ? { handle: state.sourceHandle } : {}),
              },
            });
          } catch (error) {
            if (
              operation === 'resolve-source' &&
              options.isSourceSubmissionRejected?.(error)
            ) {
              delete state.sourceSubmissionAttempted;
              delete state.sourceResult;
              delete state.sourceHandle;
              state.phase = 'initial';
              await save();
              throw error;
            }
            if (options.isHostedRequestError?.(error)) throw error;
            throw new VideoTransferError(
              'media_video_source_result_unknown',
              true,
            );
          }
          state.sourceResult = output(response) as SourceResult;
          if (state.sourceResult.handle)
            state.sourceHandle = state.sourceResult.handle;
          await save();
          if (state.sourceResult.status === 'completed') break;
          if (
            state.sourceResult.status === 'failed' ||
            state.sourceResult.status === 'canceled'
          ) {
            const failure: VideoSourceFailure = {
              status: state.sourceResult.status,
              error: state.sourceResult.error,
              sourceOperationId: state.sourceResult.sourceOperationId,
              billing: state.sourceResult.billing,
            };
            // Source payload text may include provider-private details. Only the
            // outer product-error projector decides which message is public.
            throw (
              options.sourceFailureError?.(failure) ??
              new VideoTransferError('media_video_source_failed')
            );
          }
          if (
            !['processing', 'unknown'].includes(state.sourceResult.status ?? '')
          )
            throw new VideoTransferError('media_video_source_invalid_result');
          if (now() >= deadline)
            throw new VideoTransferError('media_video_source_pending', true);
          await sleep(
            Math.min(
              dependencies.pollIntervalMs ?? 2_000,
              Math.max(0, deadline - now()),
            ),
          );
        }
        const first = state.sourceResult?.source?.videoCandidates?.[0];
        if (!first || typeof first.url !== 'string')
          throw new VideoTransferError('media_video_source_has_no_video');
        candidate = first;
      }
      state.phase = 'downloading';
      await save();
      progress('Downloading and checking the video and audio.');
      const prepared = await (dependencies.download ?? prepareDownloadedVideo)({
        ...candidate,
        directory: options.directory,
      });
      state.filePath = prepared.filePath;
      state.metadata = prepared.metadata;
    }
    state.phase = 'downloaded';
    await save();
  } else {
    const current = await inspect(state.filePath);
    if (
      current.sha256 !== state.metadata.sha256 ||
      current.bytes !== state.metadata.bytes
    )
      throw new VideoTransferError('media_video_local_file_changed');
  }
  if (options.downloadOnly)
    return {
      videoReference: null,
      filePath: state.filePath,
      metadata: state.metadata,
      sourceBilling: state.sourceResult?.billing,
    };
  if (state.fileName && state.uploadToken) return result();

  if (!state.uploadUrl || !state.uploadToken) {
    // No bytes can be sent before the returned session is persisted. A lost
    // preparation ACK can therefore recreate one empty session on explicit resume.
    if ((state.uploadPreparationAttempts ?? 0) >= 2)
      throw new VideoTransferError(
        'media_video_upload_preparation_unknown',
        true,
      );
    state.uploadPreparationAttempts =
      (state.uploadPreparationAttempts ?? 0) + 1;
    state.phase = 'upload-preparing';
    await save();
    progress('Preparing the video upload.');
    let prepared: Record<string, unknown>;
    try {
      prepared = output(
        await options.request({
          operation: 'prepare-upload',
          operationId,
          input: { metadata: state.metadata },
        }),
      );
    } catch (error) {
      if (options.isRequestRejectedBeforeExecution?.(error)) {
        state.uploadPreparationAttempts -= 1;
        if (state.uploadPreparationAttempts === 0)
          delete state.uploadPreparationAttempts;
        state.phase = 'downloaded';
        await save();
        throw error;
      }
      if (options.isHostedRequestError?.(error)) throw error;
      throw new VideoTransferError(
        'media_video_upload_preparation_unknown',
        true,
      );
    }
    if (
      typeof prepared.uploadUrl !== 'string' ||
      typeof prepared.uploadToken !== 'string' ||
      !prepared.uploadToken ||
      prepared.uploadToken.includes('/')
    )
      throw new VideoTransferError('media_video_invalid_upload_session');
    state.uploadUrl = uploadAddress(prepared.uploadUrl);
    state.uploadToken = prepared.uploadToken;
    state.expiresAt =
      typeof prepared.expiresAt === 'number' &&
      Number.isFinite(prepared.expiresAt)
        ? prepared.expiresAt
        : undefined;
    state.phase = 'upload-ready';
    await save();
  }
  if (state.expiresAt && state.expiresAt <= now())
    throw new VideoTransferError('media_video_upload_session_expired');
  const uploadUrl = uploadAddress(state.uploadUrl);
  let offset = 0;
  if (state.phase === 'uploading') {
    progress('Checking the existing upload session.');
    const response = await uploadRequest({
      headers: { 'x-goog-upload-command': 'query' },
    });
    const status = response.headers.get('x-goog-upload-status');
    if (status === 'final') return completeUpload(response);
    const received = response.headers.get('x-goog-upload-size-received');
    if (status !== 'active' || received === null || !/^\d+$/u.test(received))
      throw new VideoTransferError('media_video_upload_result_unknown', true);
    offset = Number(received);
    if (!Number.isSafeInteger(offset) || offset > state.metadata.bytes)
      throw new VideoTransferError('media_video_upload_invalid_offset');
  }
  state.phase = 'uploading';
  await save();
  progress('Uploading the video for analysis.');
  const body =
    offset < state.metadata.bytes
      ? createReadStream(state.filePath, { start: offset })
      : undefined;
  const uploadSignal = AbortSignal.timeout(VIDEO_UPLOAD_TIMEOUT_MS);
  try {
    const response = await uploadRequest({
      headers: {
        'x-goog-upload-command': 'upload, finalize',
        'x-goog-upload-offset': String(offset),
        'content-length': String(state.metadata.bytes - offset),
      },
      body: body as unknown as RequestInit['body'],
      duplex: 'half',
      signal: uploadSignal,
    });
    const name = fileNameFrom(
      await response.json().catch((error: unknown) => {
        if (uploadSignal.aborted || isTimeoutError(error)) throw error;
        return null;
      }),
    );
    if (!name)
      throw new VideoTransferError('media_video_upload_result_unknown', true);
    state.fileName = name;
    state.phase = 'uploaded';
    await save();
    return result();
  } catch (error) {
    // A timeout says nothing about whether Google finalized the bytes. Stop the
    // stream before one read-only query; never send bytes again in this call.
    body?.destroy();
    if (uploadSignal.aborted || isTimeoutError(error)) {
      progress('Upload response timed out; checking the existing session.');
      let response: Response | undefined;
      try {
        response = await uploadRequest({
          headers: { 'x-goog-upload-command': 'query' },
        });
      } catch {
        // Keep the original upload diagnostic and durable session on query failure.
      }
      if (response?.headers.get('x-goog-upload-status') === 'final')
        return completeUpload(response);
      await response?.body?.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    body?.destroy();
  }

  async function completeUpload(response: Response) {
    let name = fileNameFrom(await response.json().catch(() => null));
    if (!name) {
      progress('Recovering the completed upload identity.');
      await save();
      let recovered: Record<string, unknown>;
      try {
        recovered = output(
          await options.request({
            operation: 'recover-upload',
            operationId,
            input: { uploadToken: state.uploadToken },
          }),
        );
      } catch (error) {
        if (options.isHostedRequestError?.(error)) throw error;
        throw new VideoTransferError('media_video_upload_result_unknown', true);
      }
      if (recovered.status === 'completed')
        name = fileNameFrom({ file: { name: recovered.fileName } });
      if (!name)
        throw new VideoTransferError('media_video_upload_result_unknown', true);
    }
    state.fileName = name;
    state.phase = 'uploaded';
    await save();
    return result();
  }

  async function uploadRequest(init: RequestInit & { duplex?: 'half' }) {
    try {
      const response = await fetchResponse(uploadUrl, {
        ...init,
        method: 'POST',
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new VideoTransferError('media_video_upload_result_unknown', true);
      }
      return response;
    } catch (error) {
      if (error instanceof PostPlusNetworkRequestError) throw error;
      throw new VideoTransferError('media_video_upload_result_unknown', true, {
        cause: error,
      });
    }
  }
  function result() {
    return {
      videoReference: `postplus-video://${state.uploadToken}/${state.fileName}`,
      filePath: state.filePath!,
      metadata: state.metadata!,
      sourceBilling: state.sourceResult?.billing,
    };
  }
}

function isTimeoutError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const value = record(current);
    if (
      value.name === 'TimeoutError' ||
      value.code === 'UND_ERR_HEADERS_TIMEOUT' ||
      value.code === 'UND_ERR_BODY_TIMEOUT' ||
      value.code === 'ETIMEDOUT'
    )
      return true;
    current = value.cause;
  }
  return false;
}
