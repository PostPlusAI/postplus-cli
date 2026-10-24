import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostPlusFailure } from './failure-contract.js';
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
  uploadProtocol?: 'gcs-resumable-v1';
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
  /** Local visual evidence must finish before requesting an inference upload. */
  beforeUpload?(video: { filePath: string; metadata: LocalVideoMetadata }): Promise<void>;
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
const UPLOAD_PROTOCOL = 'gcs-resumable-v1' as const;
const OBJECT_NAME =
  /^postplus-video-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function uploadAddress(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VideoTransferError('media_video_invalid_upload_session');
  }
  const bucket =
    /^\/upload\/storage\/v1\/b\/([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])\/o$/u.exec(
      url.pathname,
    )?.[1];
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'storage.googleapis.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !bucket ||
    url.searchParams.get('uploadType') !== 'resumable' ||
    !/^[A-Za-z0-9_-]{1,2048}$/u.test(url.searchParams.get('upload_id') ?? '') ||
    [...url.searchParams.keys()].some(
      (key) =>
        !['uploadType', 'upload_id', 'name', 'ifGenerationMatch'].includes(
          key,
        ) || url.searchParams.getAll(key).length !== 1,
    ) ||
    (url.searchParams.has('name') &&
      !OBJECT_NAME.test(url.searchParams.get('name')!)) ||
    (url.searchParams.has('ifGenerationMatch') &&
      url.searchParams.get('ifGenerationMatch') !== '0')
  )
    throw new VideoTransferError('media_video_invalid_upload_session');
  return { url: url.href, bucket, objectName: url.searchParams.get('name') };
}
function fileNameFrom(value: unknown) {
  return typeof value === 'string' &&
    value.startsWith('objects/') &&
    OBJECT_NAME.test(value.slice('objects/'.length))
    ? value
    : undefined;
}
function receivedOffset(response: Response, total: number) {
  const range = response.headers.get('range');
  if (range === null) return 0;
  const matched = /^bytes=0-(\d+)$/u.exec(range);
  const offset = matched ? Number(matched[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > total)
    throw new VideoTransferError('media_video_upload_invalid_offset');
  return offset;
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
  if (
    (state.uploadProtocol !== undefined &&
      state.uploadProtocol !== UPLOAD_PROTOCOL) ||
    ((state.uploadPreparationAttempts ||
      state.uploadUrl ||
      state.uploadToken ||
      state.fileName ||
      ['upload-preparing', 'upload-ready', 'uploading', 'uploaded'].includes(
        state.phase,
      )) &&
      state.uploadProtocol !== UPLOAD_PROTOCOL)
  )
    throw new VideoTransferError('media_video_upload_protocol_unsupported');
  const save = () => options.saveState(structuredClone(state));
  const inspect = dependencies.inspect ?? inspectVideoFile;
  const now = dependencies.now ?? Date.now;
  const fetchResponse: UploadFetch =
    dependencies.fetchResponse ??
    ((url, init) =>
      fetchWithNetworkDiagnostics(url, init, {
        label: 'media-video-upload',
        // GCS uses 308 for an incomplete upload, not a redirect.
        redirectPolicy: 'manual',
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
  await options.beforeUpload?.({ filePath: state.filePath, metadata: state.metadata });
  if (
    state.uploadToken !== undefined &&
    !/^[a-zA-Z0-9_.-]+$/u.test(state.uploadToken)
  )
    throw new VideoTransferError('media_video_invalid_upload_session');
  if (state.fileName) {
    if (!state.uploadToken || !fileNameFrom(state.fileName))
      throw new VideoTransferError('media_video_invalid_upload_session');
    return result();
  }

  if (
    (!state.uploadUrl || !state.uploadToken) &&
    ['upload-ready', 'uploading', 'uploaded'].includes(state.phase)
  )
    throw new VideoTransferError('media_video_invalid_upload_session');
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
    state.uploadProtocol = UPLOAD_PROTOCOL;
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
      prepared.uploadProtocol !== UPLOAD_PROTOCOL ||
      typeof prepared.uploadUrl !== 'string' ||
      typeof prepared.uploadToken !== 'string' ||
      !prepared.uploadToken ||
      !/^[a-zA-Z0-9_.-]+$/u.test(prepared.uploadToken) ||
      typeof prepared.expiresAt !== 'number' ||
      !Number.isFinite(prepared.expiresAt)
    )
      throw new VideoTransferError('media_video_invalid_upload_session');
    state.uploadUrl = uploadAddress(prepared.uploadUrl).url;
    state.uploadToken = prepared.uploadToken;
    state.expiresAt = prepared.expiresAt;
    state.phase = 'upload-ready';
    await save();
  }
  if (state.expiresAt !== undefined && state.expiresAt <= now())
    throw new VideoTransferError('media_video_upload_session_expired');
  const session = uploadAddress(state.uploadUrl);
  const uploadUrl = session.url;
  const total = state.metadata.bytes;
  const queryUpload = () =>
    uploadRequest({
      headers: { 'content-length': '0', 'content-range': `bytes */${total}` },
    });
  let offset = 0;
  if (state.phase === 'uploading') {
    progress('Checking the existing upload session.');
    const response = await queryUpload();
    if (response.status !== 308) return completeUpload(response);
    try {
      offset = receivedOffset(response, total);
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
    if (offset === total)
      throw new VideoTransferError('media_video_upload_incomplete', true);
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
        'content-type': state.metadata.mimeType,
        'content-range': `bytes ${offset}-${total - 1}/${total}`,
        'content-length': String(state.metadata.bytes - offset),
      },
      body: body as unknown as RequestInit['body'],
      duplex: 'half',
      signal: uploadSignal,
    });
    if (response.status === 308) {
      try {
        receivedOffset(response, total);
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
      throw new VideoTransferError('media_video_upload_incomplete', true);
    }
    return await completeUpload(response, uploadSignal);
  } catch (error) {
    // A timeout says nothing about whether Google finalized the bytes. Stop the
    // stream before one read-only query; never send bytes again in this call.
    body?.destroy();
    if (uploadSignal.aborted || isTimeoutError(error)) {
      progress('Upload response timed out; checking the existing session.');
      let response: Response | undefined;
      try {
        response = await queryUpload();
      } catch {
        // Keep the original upload diagnostic and durable session on query failure.
      }
      if (response && response.status !== 308) return completeUpload(response);
      try {
        if (response) receivedOffset(response, total);
      } finally {
        await response?.body?.cancel().catch(() => undefined);
      }
    }
    throw error;
  } finally {
    body?.destroy();
  }

  async function completeUpload(response: Response, signal?: AbortSignal) {
    const object = record(
      await response.json().catch((error: unknown) => {
        if (signal?.aborted || isTimeoutError(error)) throw error;
        return null;
      }),
    );
    let name: string | undefined;
    if (object.name !== undefined || object.bucket !== undefined) {
      name =
        typeof object.name === 'string' && OBJECT_NAME.test(object.name)
          ? `objects/${object.name}`
          : undefined;
      if (
        !name ||
        object.bucket !== session.bucket ||
        (session.objectName && object.name !== session.objectName)
      )
        throw new VideoTransferError('media_video_upload_invalid_object');
    }
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
        name = fileNameFrom(recovered.fileName);
      if (!name)
        throw new VideoTransferError('media_video_upload_result_unknown', true);
      if (session.objectName && name !== `objects/${session.objectName}`)
        throw new VideoTransferError('media_video_upload_invalid_object');
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
        method: 'PUT',
        redirect: 'manual',
        signal: init.signal ?? AbortSignal.timeout(30_000),
      });
      if (
        ![200, 201, 308].includes(response.status) ||
        response.headers.has('location')
      ) {
        await response.body?.cancel();
        throw new VideoTransferError('media_video_upload_result_unknown', true);
      }
      return response;
    } catch (error) {
      if (
        error instanceof PostPlusNetworkRequestError ||
        error instanceof PostPlusFailure ||
        error instanceof VideoTransferError
      )
        throw error;
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
