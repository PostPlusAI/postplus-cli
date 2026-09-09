import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { getPostPlusConfigDir } from './local-state.js';
import {
  formatNetworkErrorChain,
  readTargetHost,
} from './network-diagnostics.js';

const TUS_VERSION = '1.0.0';
const DEFAULT_TUS_CHUNK_SIZE_BYTES = 6 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const CHECKPOINT_FILE_MODE = 0o600;
const DOWNLOAD_LIMIT_BYTES = 200 * 1024 * 1024;

export type MediaFileFingerprint = {
  contentSha256: string;
  mtimeMs: number;
  sizeBytes: number;
};

export type HostedMediaTransferProgress = {
  attempt: number;
  checkpointId: string;
  stage: 'transferring';
  totalBytes: number | null;
  transferredBytes: number;
  userAction?: string;
};

export type SignedHostedUpload =
  | {
      method: 'PUT';
      requiredHeaders: Record<string, string>;
      url: string;
    }
  | {
      chunkSizeBytes: number;
      expiresInSeconds: number;
      metadata: Record<string, string>;
      method: 'TUS';
      requiredHeaders: Record<string, string>;
      url: string;
    };

export type HostedMediaTransferErrorCode =
  | 'connect_timeout'
  | 'idle_timeout'
  | 'integrity_mismatch'
  | 'size_limit'
  | 'source_rejected'
  | 'upload_session_expired';

export type HostedMediaDownloadStage =
  | 'commit-output'
  | 'fetch-bytes'
  | 'receive-response'
  | 'resolve-read-url'
  | 'stream-bytes';

export class HostedMediaDownloadError extends Error {
  readonly checkpointId: string;
  readonly code: HostedMediaTransferErrorCode;
  readonly resumeAvailable: boolean;
  readonly retryable: boolean;
  readonly stage: HostedMediaDownloadStage;
  readonly targetHost: string;
  readonly totalBytes: number | null;
  readonly transferredBytes: number;
  readonly userAction: string;

  constructor(input: {
    cause?: unknown;
    checkpointId: string;
    code: HostedMediaTransferErrorCode;
    detail?: string;
    resumeAvailable: boolean;
    retryable: boolean;
    stage: HostedMediaDownloadStage;
    targetUrl: string;
    totalBytes: number | null;
    transferredBytes: number;
    userAction: string;
  }) {
    const targetHost = readTargetHost(input.targetUrl);
    const detail =
      input.detail ?? formatNetworkErrorChain(input.cause ?? 'unknown error');
    super(
      `Hosted media download failed (code=${input.code}, stage=${input.stage}, host=${targetHost}, transferredBytes=${input.transferredBytes}, totalBytes=${input.totalBytes ?? 'unknown'}, retryable=${input.retryable}, resumeAvailable=${input.resumeAvailable}, checkpointId=${input.checkpointId}, userAction=${input.userAction}): ${detail}`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = 'HostedMediaDownloadError';
    this.checkpointId = input.checkpointId;
    this.code = input.code;
    this.resumeAvailable = input.resumeAvailable;
    this.retryable = input.retryable;
    this.stage = input.stage;
    this.targetHost = targetHost;
    this.totalBytes = input.totalBytes;
    this.transferredBytes = input.transferredBytes;
    this.userAction = input.userAction;
  }
}

export class HostedMediaTransferError extends Error {
  readonly checkpointId: string;
  readonly code: HostedMediaTransferErrorCode;
  readonly resumeAvailable: boolean;
  readonly retryable: boolean;
  readonly stage = 'transferring';
  readonly targetHost: string;
  readonly totalBytes: number;
  readonly transferredBytes: number;
  readonly userAction: string;

  constructor(input: {
    cause?: unknown;
    checkpointId: string;
    code: HostedMediaTransferErrorCode;
    message: string;
    resumeAvailable: boolean;
    retryable: boolean;
    targetUrl: string;
    totalBytes: number;
    transferredBytes: number;
    userAction: string;
  }) {
    const targetHost = safeTargetHost(input.targetUrl);
    super(
      `${input.message} (code=${input.code}, stage=transferring, host=${targetHost}, transferredBytes=${input.transferredBytes}, totalBytes=${input.totalBytes}, retryable=${input.retryable}, resumeAvailable=${input.resumeAvailable}, checkpointId=${input.checkpointId}, userAction=${input.userAction})`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = 'HostedMediaTransferError';
    this.checkpointId = input.checkpointId;
    this.code = input.code;
    this.resumeAvailable = input.resumeAvailable;
    this.retryable = input.retryable;
    this.targetHost = targetHost;
    this.totalBytes = input.totalBytes;
    this.transferredBytes = input.transferredBytes;
    this.userAction = input.userAction;
  }
}

type UploadCheckpoint = {
  confirmedOffset: number;
  expiresAt: number;
  fingerprint: MediaFileFingerprint;
  operationId: string;
  uploadUrl: string;
  targetIdentity: string;
  mediaReference: string;
  signedUpload: Extract<SignedHostedUpload, { method: 'TUS' }>;
};

type CompletedUpload = {
  operationId: string;
  fingerprint: MediaFileFingerprint;
  targetIdentity: string;
  mediaReference: string;
};

type UploadCheckpointFile = {
  completed?: CompletedUpload;
  entries: Record<string, UploadCheckpoint>;
  schemaVersion: 'postplus-media-transfer-checkpoints/v1';
};

type DownloadCheckpoint = {
  checkpointId: string;
  etag: string | null;
  lastModified: string | null;
  receivedBytes: number;
  sourceHash: string;
  totalBytes: number;
};

type UploadOptions = {
  persistCheckpoint?: boolean;
  connectTimeoutMs?: number;
  fetchFn?: typeof fetch;
  idleTimeoutMs?: number;
  maxAttempts?: number;
  onProgress?: (progress: HostedMediaTransferProgress) => void;
  sleepMs?: (milliseconds: number) => Promise<void>;
};

export async function createMediaFileFingerprint(
  absolutePath: string,
): Promise<MediaFileFingerprint> {
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error(`Hosted media source is not a file: ${absolutePath}`);
  }
  return {
    contentSha256: await sha256File(absolutePath),
    mtimeMs: fileStat.mtimeMs,
    sizeBytes: fileStat.size,
  };
}

export async function sha256File(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export function buildMediaTransferCheckpointId(input: {
  fingerprint: MediaFileFingerprint;
  operationId: string;
}): string {
  return createHash('sha256').update(input.operationId).digest('hex');
}

// CLI-only durable recovery. Invoke before asking the server for another signature.
export async function resumeHostedMediaUpload(input: {
  owner: string;
  absolutePath: string;
  fingerprint: MediaFileFingerprint;
  operationId: string;
  options?: UploadOptions;
}): Promise<{ mediaReference: string; reusedCompleted: boolean } | null> {
  const checkpointId = buildMediaTransferCheckpointId(input);
  const record = await readCheckpointFile(checkpointId);
  const saved = record.completed ?? record.entries[checkpointId];
  if (!saved) return null;
  await assertFingerprintMatches(input.absolutePath, input.fingerprint, true);
  let identity: unknown;
  try {
    identity = JSON.parse(saved.targetIdentity);
  } catch {
    throw new Error('Media upload checkpoint target identity is unreadable.');
  }
  if (
    saved.operationId !== input.operationId ||
    !sameFingerprint(saved.fingerprint, input.fingerprint) ||
    !Array.isArray(identity) ||
    identity[0] !== input.owner
  ) {
    throw new Error(
      'Media upload checkpoint does not match the source, operation or account.',
    );
  }
  if (record.completed)
    return {
      mediaReference: record.completed.mediaReference,
      reusedCompleted: true,
    };
  const session = record.entries[checkpointId]!;
  if (session.expiresAt <= Date.now())
    throw new Error(
      'Original upload session expired; its result is unknown. Verify the original operation before starting another upload.',
    );
  const expected = JSON.stringify([
    input.owner,
    new URL(session.signedUpload.url).origin,
    session.signedUpload.metadata.bucketName,
    session.signedUpload.metadata.objectName,
  ]);
  if (session.targetIdentity !== expected)
    throw new Error(
      'Media upload checkpoint does not match its original storage target.',
    );
  assertTusSessionUrl(session.uploadUrl, session.signedUpload.url);
  return uploadHostedMediaFile({
    ...input,
    mediaReference: session.mediaReference,
    signedUpload: session.signedUpload,
  });
}

export async function uploadHostedMediaFile(input: {
  owner: string;
  mediaReference: string;
  absolutePath: string;
  fingerprint: MediaFileFingerprint;
  operationId: string;
  signedUpload: SignedHostedUpload;
  signedAt?: number;
  options?: UploadOptions;
}): Promise<{
  checkpointId: string;
  sizeBytes: number;
  mediaReference: string;
  reusedCompleted: boolean;
}> {
  await assertFingerprintMatches(input.absolutePath, input.fingerprint, true);
  const checkpointId = buildMediaTransferCheckpointId(input);
  const targetIdentity =
    input.signedUpload.method === 'TUS'
      ? JSON.stringify([
          input.owner,
          new URL(input.signedUpload.url).origin,
          input.signedUpload.metadata.bucketName,
          input.signedUpload.metadata.objectName,
        ])
      : JSON.stringify([
          input.owner,
          new URL(input.signedUpload.url).origin,
          input.mediaReference,
        ]);
  const completed =
    input.options?.persistCheckpoint === false
      ? undefined
      : (await readCheckpointFile(checkpointId)).completed;
  if (completed) {
    if (
      completed.operationId !== input.operationId ||
      completed.targetIdentity !== targetIdentity ||
      completed.mediaReference !== input.mediaReference ||
      !sameFingerprint(completed.fingerprint, input.fingerprint)
    ) {
      throw new Error(
        'Completed media upload checkpoint does not match the source, operation or target.',
      );
    }
    return {
      checkpointId,
      sizeBytes: input.fingerprint.sizeBytes,
      mediaReference: completed.mediaReference,
      reusedCompleted: true,
    };
  }
  const recordCompleted = async () => {
    if (input.options?.persistCheckpoint !== false)
      await writeCheckpointFile(
        {
          ...emptyCheckpointFile(),
          completed: {
            operationId: input.operationId,
            fingerprint: input.fingerprint,
            targetIdentity,
            mediaReference: input.mediaReference,
          },
        },
        checkpointId,
      );
    return {
      checkpointId,
      sizeBytes: input.fingerprint.sizeBytes,
      mediaReference: input.mediaReference,
      reusedCompleted: false,
    };
  };

  if (input.signedUpload.method === 'PUT') {
    await uploadWithPut({
      absolutePath: input.absolutePath,
      checkpointId,
      fingerprint: input.fingerprint,
      options: input.options ?? {},
      signedUpload: input.signedUpload,
    });
    return recordCompleted();
  }

  await uploadWithTus({
    mediaReference: input.mediaReference,
    signedAt: input.signedAt ?? Date.now(),
    owner: input.owner,
    absolutePath: input.absolutePath,
    checkpointId,
    fingerprint: input.fingerprint,
    operationId: input.operationId,
    options: input.options ?? {},
    signedUpload: input.signedUpload,
  });
  return recordCompleted();
}

export async function downloadHostedMediaFile(input: {
  absoluteOutput: string;
  debug: boolean;
  operationId: string;
  sourceIdentity: string;
  validate?: (partialPath: string) => Promise<void>;
  request: (url: string, init: RequestInit) => Promise<Response>;
  restart?: boolean;
  url: string;
  options?: {
    persistCheckpoint?: boolean;
    connectTimeoutMs?: number;
    idleTimeoutMs?: number;
    onProgress?: (progress: HostedMediaTransferProgress) => void;
  };
}): Promise<number> {
  const outputDirectory = path.dirname(input.absoluteOutput);
  const partialOutput = path.join(
    outputDirectory,
    `.${path.basename(input.absoluteOutput)}.postplus-download.part`,
  );
  const checkpointPath = `${partialOutput}.json`;
  const checkpointId = createHash('sha256')
    .update(`${input.operationId}\n${input.absoluteOutput}`)
    .digest('hex');
  const sourceHash = createHash('sha256')
    .update(JSON.stringify([input.operationId, input.sourceIdentity]))
    .digest('hex');
  await mkdir(outputDirectory, { recursive: true });
  if (input.restart) {
    await Promise.all([
      rm(partialOutput, { force: true }),
      rm(checkpointPath, { force: true }),
    ]);
  }

  let checkpoint =
    input.options?.persistCheckpoint === false
      ? null
      : await readDownloadCheckpoint(checkpointPath);
  let receivedBytes = 0;
  if (checkpoint) {
    const partialStat = await stat(partialOutput).catch(() => null);
    if (
      checkpoint.checkpointId !== checkpointId ||
      checkpoint.sourceHash !== sourceHash ||
      !partialStat ||
      partialStat.size !== checkpoint.receivedBytes
    ) {
      throw downloadError({
        checkpointId,
        code: 'integrity_mismatch',
        detail: 'The partial download and its checkpoint do not match.',
        resumeAvailable: false,
        retryable: false,
        stage: 'stream-bytes',
        targetUrl: input.url,
        totalBytes: checkpoint.totalBytes,
        transferredBytes: partialStat?.size ?? 0,
        userAction: 'Rerun with --restart to discard the unsafe partial file.',
      });
    }
    receivedBytes = checkpoint.receivedBytes;
    if (receivedBytes === checkpoint.totalBytes) {
      await input.validate?.(partialOutput);
      await commitDownloadedFile({
        absoluteOutput: input.absoluteOutput,
        checkpointId,
        checkpointPath,
        partialOutput,
        targetUrl: input.url,
        totalBytes: checkpoint.totalBytes,
      });
      return checkpoint.totalBytes;
    }
  } else {
    const partialStat = await stat(partialOutput).catch(() => null);
    if (partialStat) {
      throw downloadError({
        checkpointId,
        code: 'integrity_mismatch',
        detail: 'A partial download exists without a trusted checkpoint.',
        resumeAvailable: false,
        retryable: false,
        stage: 'stream-bytes',
        targetUrl: input.url,
        totalBytes: null,
        transferredBytes: partialStat.size,
        userAction:
          'Rerun with --restart to discard the untrusted partial file.',
      });
    }
  }

  const headers: Record<string, string> = {};
  if (checkpoint) {
    headers.range = `bytes=${checkpoint.receivedBytes}-`;
    headers['if-range'] = checkpoint.etag ?? checkpoint.lastModified ?? '';
  }
  const controller = new AbortController();
  const connectTimeoutMs =
    input.options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = input.options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  let timeout = setTimeout(() => controller.abort(), connectTimeoutMs);
  let response: Response;
  try {
    response = await input.request(input.url, {
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw downloadError({
      cause: error,
      checkpointId,
      code: controller.signal.aborted ? 'connect_timeout' : 'source_rejected',
      resumeAvailable: Boolean(checkpoint),
      retryable: true,
      stage: 'fetch-bytes',
      targetUrl: input.url,
      totalBytes: checkpoint?.totalBytes ?? null,
      transferredBytes: receivedBytes,
      userAction: checkpoint
        ? 'Run the same command again to resume the download.'
        : 'Retry the command.',
    });
  }

  if (!response.ok || !response.body) {
    clearTimeout(timeout);
    void response.body?.cancel().catch(() => {});
    throw downloadError({
      checkpointId,
      code: 'source_rejected',
      detail: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}; response body ${response.body ? 'present' : 'missing'}`,
      resumeAvailable: Boolean(checkpoint),
      retryable: response.status >= 500,
      stage: 'receive-response',
      targetUrl: input.url,
      totalBytes: checkpoint?.totalBytes ?? null,
      transferredBytes: receivedBytes,
      userAction:
        response.status >= 500
          ? 'Run the same command again.'
          : 'Correct the source or permissions before retrying.',
    });
  }

  const responseShape = resolveDownloadResponseShape({
    checkpoint,
    response,
  });
  if ('error' in responseShape) {
    clearTimeout(timeout);
    void response.body.cancel().catch(() => {});
    throw downloadError({
      checkpointId,
      code: responseShape.error,
      detail: responseShape.detail,
      resumeAvailable: false,
      retryable: false,
      stage: 'receive-response',
      targetUrl: input.url,
      totalBytes: checkpoint?.totalBytes ?? null,
      transferredBytes: receivedBytes,
      userAction: 'Rerun with --restart to transfer the object from byte zero.',
    });
  }

  if (
    responseShape.totalBytes !== null &&
    responseShape.totalBytes > DOWNLOAD_LIMIT_BYTES
  ) {
    clearTimeout(timeout);
    void response.body.cancel().catch(() => {});
    throw downloadError({
      checkpointId,
      code: 'size_limit',
      detail: 'Hosted media download exceeds the 200 MiB product limit.',
      resumeAvailable: false,
      retryable: false,
      stage: 'receive-response',
      targetUrl: input.url,
      totalBytes: responseShape.totalBytes,
      transferredBytes: receivedBytes,
      userAction: 'Use a supported media object at or below 200 MiB.',
    });
  }

  checkpoint =
    input.options?.persistCheckpoint !== false &&
    responseShape.resumeSupported &&
    responseShape.totalBytes !== null
      ? {
          checkpointId,
          etag: responseShape.etag,
          lastModified: responseShape.lastModified,
          receivedBytes,
          sourceHash,
          totalBytes: responseShape.totalBytes,
        }
      : null;
  if (checkpoint) {
    try {
      await writeDownloadCheckpoint(checkpointPath, checkpoint);
    } catch (error) {
      clearTimeout(timeout);
      void response.body.cancel().catch(() => {});
      throw error;
    }
  }

  const progressStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > DOWNLOAD_LIMIT_BYTES) {
        callback(
          downloadError({
            checkpointId,
            code: 'size_limit',
            detail: 'Hosted media download exceeded the 200 MiB product limit.',
            resumeAvailable: false,
            retryable: false,
            stage: 'stream-bytes',
            targetUrl: input.url,
            totalBytes: responseShape.totalBytes,
            transferredBytes: receivedBytes,
            userAction: 'Use a supported media object at or below 200 MiB.',
          }),
        );
        return;
      }
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), idleTimeoutMs);
      input.options?.onProgress?.({
        attempt: 1,
        checkpointId,
        stage: 'transferring',
        totalBytes: responseShape.totalBytes,
        transferredBytes: receivedBytes,
      });
      callback(null, chunk);
    },
  });
  clearTimeout(timeout);
  timeout = setTimeout(() => controller.abort(), idleTimeoutMs);

  try {
    await pipeline(
      Readable.fromWeb(
        response.body as import('node:stream/web').ReadableStream,
      ),
      progressStream,
      createWriteStream(partialOutput, {
        flags: receivedBytes > 0 ? 'a' : 'wx',
      }),
      { signal: controller.signal },
    );
  } catch (error) {
    clearTimeout(timeout);
    const partialStat = await stat(partialOutput).catch(() => null);
    receivedBytes = partialStat?.size ?? receivedBytes;
    if (checkpoint) {
      checkpoint.receivedBytes = receivedBytes;
      await writeDownloadCheckpoint(checkpointPath, checkpoint);
    } else {
      await Promise.all([
        rm(partialOutput, { force: true }),
        rm(checkpointPath, { force: true }),
      ]);
    }
    if (error instanceof HostedMediaDownloadError) throw error;
    throw downloadError({
      cause: error,
      checkpointId,
      code: controller.signal.aborted ? 'idle_timeout' : 'source_rejected',
      resumeAvailable: Boolean(checkpoint),
      retryable: true,
      stage: 'stream-bytes',
      targetUrl: input.url,
      totalBytes: responseShape.totalBytes,
      transferredBytes: receivedBytes,
      userAction: checkpoint
        ? 'Run the same command again to resume from the confirmed local bytes.'
        : 'The server does not support safe resume; retry retransfers from byte zero.',
    });
  } finally {
    clearTimeout(timeout);
  }

  if (
    responseShape.totalBytes !== null &&
    receivedBytes !== responseShape.totalBytes
  ) {
    if (checkpoint) {
      checkpoint.receivedBytes = receivedBytes;
      await writeDownloadCheckpoint(checkpointPath, checkpoint);
    }
    throw downloadError({
      checkpointId,
      code: 'integrity_mismatch',
      detail:
        'Hosted media download byte count does not match the remote object.',
      resumeAvailable: Boolean(checkpoint),
      retryable: false,
      stage: 'stream-bytes',
      targetUrl: input.url,
      totalBytes: responseShape.totalBytes,
      transferredBytes: receivedBytes,
      userAction: 'Rerun with --restart after verifying the source object.',
    });
  }

  await input.validate?.(partialOutput);
  if (checkpoint) {
    checkpoint.receivedBytes = receivedBytes;
    await writeDownloadCheckpoint(checkpointPath, checkpoint);
  }
  await commitDownloadedFile({
    absoluteOutput: input.absoluteOutput,
    checkpointId,
    checkpointPath,
    partialOutput,
    targetUrl: input.url,
    totalBytes: responseShape.totalBytes ?? receivedBytes,
  });
  return receivedBytes;
}

async function uploadWithPut(input: {
  absolutePath: string;
  checkpointId: string;
  fingerprint: MediaFileFingerprint;
  options: UploadOptions;
  signedUpload: Extract<SignedHostedUpload, { method: 'PUT' }>;
}) {
  const fetchFn = input.options.fetchFn ?? fetch;
  const idleTimeoutMs = input.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  let transferredBytes = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
  };
  resetIdleTimer();
  const progressStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      transferredBytes += chunk.byteLength;
      resetIdleTimer();
      input.options.onProgress?.({
        attempt: 1,
        checkpointId: input.checkpointId,
        stage: 'transferring',
        totalBytes: input.fingerprint.sizeBytes,
        transferredBytes,
      });
      callback(null, chunk);
    },
  });

  const source = createReadStream(input.absolutePath);
  source.on('error', (error) => progressStream.destroy(error));
  try {
    const response = await fetchFn(input.signedUpload.url, {
      body: source.pipe(progressStream),
      duplex: 'half',
      headers: input.signedUpload.requiredHeaders,
      method: 'PUT',
      redirect: 'error',
      signal: controller.signal,
    } as RequestInit & { duplex: 'half' });
    void response.body?.cancel().catch(() => {});
    if (!response.ok) {
      throw transferError({
        checkpointId: input.checkpointId,
        code: 'source_rejected',
        message: `Hosted media upload was rejected with HTTP ${response.status}.`,
        resumeAvailable: false,
        retryable: false,
        targetUrl: input.signedUpload.url,
        totalBytes: input.fingerprint.sizeBytes,
        transferredBytes,
        userAction: 'Request a fresh upload URL and retry the command.',
      });
    }
    await assertFingerprintMatches(input.absolutePath, input.fingerprint, true);
  } catch (error) {
    if (error instanceof HostedMediaTransferError) throw error;
    throw transferError({
      cause: error,
      checkpointId: input.checkpointId,
      code: controller.signal.aborted ? 'idle_timeout' : 'source_rejected',
      message: controller.signal.aborted
        ? 'Hosted media upload stalled without byte progress.'
        : 'Hosted media upload failed before completion.',
      resumeAvailable: false,
      retryable: false,
      targetUrl: input.signedUpload.url,
      totalBytes: input.fingerprint.sizeBytes,
      transferredBytes,
      userAction: 'Retry the command; small uploads restart from byte zero.',
    });
  } finally {
    source.destroy();
    progressStream.destroy();
    if (idleTimer) clearTimeout(idleTimer);
  }
}

async function uploadWithTus(input: {
  mediaReference: string;
  signedAt: number;
  owner: string;
  absolutePath: string;
  checkpointId: string;
  fingerprint: MediaFileFingerprint;
  operationId: string;
  options: UploadOptions;
  signedUpload: Extract<SignedHostedUpload, { method: 'TUS' }>;
}) {
  const fetchFn = input.options.fetchFn ?? fetch;
  const sleepMs = input.options.sleepMs ?? sleep;
  const connectTimeoutMs =
    input.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = input.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxAttempts = input.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const targetIdentity = JSON.stringify([
    input.owner,
    new URL(input.signedUpload.url).origin,
    input.signedUpload.metadata.bucketName,
    input.signedUpload.metadata.objectName,
  ]);
  if (
    !input.signedUpload.metadata.bucketName ||
    !input.signedUpload.metadata.objectName
  ) {
    throw new Error(
      'Signed TUS upload is missing its storage target identity.',
    );
  }
  const checkpoints =
    input.options.persistCheckpoint === false
      ? emptyCheckpointFile()
      : await readCheckpointFile(input.checkpointId);
  const saveCheckpoint = async () => {
    if (input.options.persistCheckpoint !== false)
      await writeCheckpointFile(checkpoints, input.checkpointId);
  };
  let checkpoint: UploadCheckpoint | undefined =
    checkpoints.entries[input.checkpointId];

  if (
    checkpoint &&
    (checkpoint.targetIdentity !== targetIdentity ||
      checkpoint.mediaReference !== input.mediaReference ||
      !sameFingerprint(checkpoint.fingerprint, input.fingerprint))
  ) {
    throw transferError({
      checkpointId: input.checkpointId,
      code: 'integrity_mismatch',
      message:
        'Hosted media upload checkpoint does not match the current file.',
      resumeAvailable: false,
      retryable: false,
      targetUrl: input.signedUpload.url,
      totalBytes: input.fingerprint.sizeBytes,
      transferredBytes: checkpoint.confirmedOffset,
      userAction: 'Restore the original file or start a new operation.',
    });
  }

  const unavailableSession = () =>
    transferError({
      checkpointId: input.checkpointId,
      code: 'upload_session_expired',
      message: 'Original upload session is unavailable; its result is unknown.',
      resumeAvailable: false,
      retryable: false,
      targetUrl: input.signedUpload.url,
      totalBytes: input.fingerprint.sizeBytes,
      transferredBytes: checkpoint?.confirmedOffset ?? 0,
      userAction:
        'Verify the original operation before starting another upload.',
    });
  if (checkpoint && checkpoint.expiresAt <= Date.now())
    throw unavailableSession();

  if (checkpoint) {
    assertTusSessionUrl(checkpoint.uploadUrl, input.signedUpload.url);
    const remoteOffset = await readTusOffset({
      checkpointId: input.checkpointId,
      connectTimeoutMs,
      fetchFn,
      fingerprint: input.fingerprint,
      signedUpload: input.signedUpload,
      uploadUrl: checkpoint.uploadUrl,
    });
    if (remoteOffset === null) throw unavailableSession();
    checkpoint.confirmedOffset = remoteOffset;
    await saveCheckpoint();
  }

  if (!checkpoint) {
    checkpoint = await createTusSession({
      mediaReference: input.mediaReference,
      expiresAt: input.signedAt + input.signedUpload.expiresInSeconds * 1000,
      targetIdentity,
      checkpointId: input.checkpointId,
      connectTimeoutMs,
      fetchFn,
      fingerprint: input.fingerprint,
      operationId: input.operationId,
      signedUpload: input.signedUpload,
    });
    checkpoints.entries[input.checkpointId] = checkpoint;
    await saveCheckpoint();
  }

  let confirmedOffset = checkpoint.confirmedOffset;
  let attempt = 1;
  while (confirmedOffset < input.fingerprint.sizeBytes) {
    await assertFingerprintMatches(input.absolutePath, input.fingerprint);
    const chunkEnd = Math.min(
      confirmedOffset +
        (input.signedUpload.chunkSizeBytes || DEFAULT_TUS_CHUNK_SIZE_BYTES),
      input.fingerprint.sizeBytes,
    );
    try {
      confirmedOffset = await patchTusChunk({
        absolutePath: input.absolutePath,
        attempt,
        checkpointId: input.checkpointId,
        endOffset: chunkEnd,
        fetchFn,
        fingerprint: input.fingerprint,
        idleTimeoutMs,
        onProgress: input.options.onProgress,
        signedUpload: input.signedUpload,
        startOffset: confirmedOffset,
        uploadUrl: checkpoint.uploadUrl,
      });
      checkpoint.confirmedOffset = confirmedOffset;
      checkpoints.entries[input.checkpointId] = checkpoint;
      await saveCheckpoint();
      attempt = 1;
    } catch (error) {
      if (error instanceof HostedMediaTransferError && !error.retryable) {
        throw error;
      }
      if (attempt >= maxAttempts) {
        if (error instanceof HostedMediaTransferError) throw error;
        throw transferError({
          cause: error,
          checkpointId: input.checkpointId,
          code: 'idle_timeout',
          message: 'Hosted media upload exhausted its bounded retry budget.',
          resumeAvailable: true,
          retryable: true,
          targetUrl: checkpoint.uploadUrl,
          totalBytes: input.fingerprint.sizeBytes,
          transferredBytes: confirmedOffset,
          userAction: 'Run the same command again to resume this upload.',
        });
      }
      attempt += 1;
      await sleepMs(Math.min(1_000 * 2 ** (attempt - 2), 8_000));
      const remoteOffset = await readTusOffset({
        checkpointId: input.checkpointId,
        connectTimeoutMs,
        fetchFn,
        fingerprint: input.fingerprint,
        signedUpload: input.signedUpload,
        uploadUrl: checkpoint.uploadUrl,
      });
      if (remoteOffset === null) throw unavailableSession();
      confirmedOffset = remoteOffset;
      checkpoint.confirmedOffset = remoteOffset;
      checkpoints.entries[input.checkpointId] = checkpoint;
      await saveCheckpoint();
    }
  }

  await assertFingerprintMatches(input.absolutePath, input.fingerprint, true);
  // Keep the confirmed session until recordCompleted atomically replaces it.
  // A failed completed write must never expose an empty recovery state.
}

function assertTusSessionUrl(location: string, endpoint: string) {
  const expected = new URL(endpoint);
  let target: URL;
  try {
    target = new URL(location, expected);
  } catch {
    throw new Error('TUS session location is invalid.');
  }
  if (
    target.origin !== expected.origin ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new Error(
      'TUS session location does not match the signed upload origin.',
    );
  }
  return target.href;
}

async function createTusSession(input: {
  mediaReference: string;
  expiresAt: number;
  targetIdentity: string;
  checkpointId: string;
  connectTimeoutMs: number;
  fetchFn: typeof fetch;
  fingerprint: MediaFileFingerprint;
  operationId: string;
  signedUpload: Extract<SignedHostedUpload, { method: 'TUS' }>;
}): Promise<UploadCheckpoint> {
  const response = await fetchWithConnectTimeout({
    checkpointId: input.checkpointId,
    fetchFn: input.fetchFn,
    init: {
      headers: {
        ...input.signedUpload.requiredHeaders,
        'tus-resumable': TUS_VERSION,
        'upload-length': String(input.fingerprint.sizeBytes),
        'upload-metadata': encodeTusMetadata({
          ...input.signedUpload.metadata,
          operationId: input.operationId,
          sha256: input.fingerprint.contentSha256,
        }),
      },
      method: 'POST',
    },
    targetUrl: input.signedUpload.url,
    timeoutMs: input.connectTimeoutMs,
    totalBytes: input.fingerprint.sizeBytes,
    transferredBytes: 0,
  });
  void response.body?.cancel().catch(() => {});
  if (response.status !== 201) {
    throw transferError({
      checkpointId: input.checkpointId,
      code: 'source_rejected',
      message: `Hosted media TUS session creation was rejected with HTTP ${response.status}.`,
      resumeAvailable: false,
      retryable: response.status >= 500,
      targetUrl: input.signedUpload.url,
      totalBytes: input.fingerprint.sizeBytes,
      transferredBytes: 0,
      userAction:
        response.status >= 500
          ? 'Retry the same command.'
          : 'Check account permissions and request a fresh upload URL.',
    });
  }
  const location = response.headers.get('location');
  if (!location) {
    throw transferError({
      checkpointId: input.checkpointId,
      code: 'source_rejected',
      message: 'Hosted media TUS session response is missing Location.',
      resumeAvailable: false,
      retryable: false,
      targetUrl: input.signedUpload.url,
      totalBytes: input.fingerprint.sizeBytes,
      transferredBytes: 0,
      userAction: 'Retry after the Storage service is repaired.',
    });
  }
  return {
    confirmedOffset: 0,
    expiresAt: input.expiresAt,
    mediaReference: input.mediaReference,
    signedUpload: input.signedUpload,
    fingerprint: input.fingerprint,
    operationId: input.operationId,
    uploadUrl: assertTusSessionUrl(location, input.signedUpload.url),
    targetIdentity: input.targetIdentity,
  };
}

async function readTusOffset(input: {
  checkpointId: string;
  connectTimeoutMs: number;
  fetchFn: typeof fetch;
  fingerprint: MediaFileFingerprint;
  signedUpload: Extract<SignedHostedUpload, { method: 'TUS' }>;
  uploadUrl: string;
}): Promise<number | null> {
  const response = await fetchWithConnectTimeout({
    checkpointId: input.checkpointId,
    fetchFn: input.fetchFn,
    init: {
      headers: {
        ...input.signedUpload.requiredHeaders,
        'tus-resumable': TUS_VERSION,
      },
      method: 'HEAD',
    },
    targetUrl: input.uploadUrl,
    timeoutMs: input.connectTimeoutMs,
    totalBytes: input.fingerprint.sizeBytes,
    transferredBytes: 0,
  });
  void response.body?.cancel().catch(() => {});
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) {
    throw transferError({
      checkpointId: input.checkpointId,
      code: 'source_rejected',
      message: `Hosted media TUS offset query failed with HTTP ${response.status}.`,
      resumeAvailable: true,
      retryable: response.status >= 500,
      targetUrl: input.uploadUrl,
      totalBytes: input.fingerprint.sizeBytes,
      transferredBytes: 0,
      userAction: 'Retry the same command to query the confirmed offset again.',
    });
  }
  const offsetHeader = response.headers.get('upload-offset');
  const lengthHeader = response.headers.get('upload-length');
  const offset =
    offsetHeader !== null && /^\d+$/.test(offsetHeader)
      ? Number(offsetHeader)
      : NaN;
  const length =
    lengthHeader !== null && /^\d+$/.test(lengthHeader)
      ? Number(lengthHeader)
      : NaN;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > input.fingerprint.sizeBytes ||
    length !== input.fingerprint.sizeBytes
  ) {
    throw transferError({
      checkpointId: input.checkpointId,
      code: 'integrity_mismatch',
      message: 'Hosted media TUS session returned an invalid offset or length.',
      resumeAvailable: false,
      retryable: false,
      targetUrl: input.uploadUrl,
      totalBytes: input.fingerprint.sizeBytes,
      transferredBytes: 0,
      userAction:
        'Start a new operation; the existing upload session is unsafe to resume.',
    });
  }
  return offset;
}

async function patchTusChunk(input: {
  absolutePath: string;
  attempt: number;
  checkpointId: string;
  endOffset: number;
  fetchFn: typeof fetch;
  fingerprint: MediaFileFingerprint;
  idleTimeoutMs: number;
  onProgress?: (progress: HostedMediaTransferProgress) => void;
  signedUpload: Extract<SignedHostedUpload, { method: 'TUS' }>;
  startOffset: number;
  uploadUrl: string;
}): Promise<number> {
  const controller = new AbortController();
  let sentBytes = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), input.idleTimeoutMs);
  };
  resetIdleTimer();
  const progressStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sentBytes += chunk.byteLength;
      resetIdleTimer();
      input.onProgress?.({
        attempt: input.attempt,
        checkpointId: input.checkpointId,
        stage: 'transferring',
        totalBytes: input.fingerprint.sizeBytes,
        transferredBytes: input.startOffset + sentBytes,
      });
      callback(null, chunk);
    },
  });

  const source = createReadStream(input.absolutePath, {
    end: input.endOffset - 1,
    start: input.startOffset,
  });
  source.on('error', (error) => progressStream.destroy(error));
  try {
    const response = await input.fetchFn(input.uploadUrl, {
      body: source.pipe(progressStream),
      duplex: 'half',
      headers: {
        ...input.signedUpload.requiredHeaders,
        'content-length': String(input.endOffset - input.startOffset),
        'content-type': 'application/offset+octet-stream',
        'tus-resumable': TUS_VERSION,
        'upload-offset': String(input.startOffset),
      },
      method: 'PATCH',
      redirect: 'error',
      signal: controller.signal,
    } as RequestInit & { duplex: 'half' });
    void response.body?.cancel().catch(() => {});
    if (response.status >= 500) {
      throw transferError({
        checkpointId: input.checkpointId,
        code: 'source_rejected',
        message: `Hosted media TUS chunk failed with retryable HTTP ${response.status}.`,
        resumeAvailable: true,
        retryable: true,
        targetUrl: input.uploadUrl,
        totalBytes: input.fingerprint.sizeBytes,
        transferredBytes: input.startOffset,
        userAction:
          'Retry the same command to resume from the confirmed offset.',
      });
    }
    if (response.status !== 204) {
      throw transferError({
        checkpointId: input.checkpointId,
        code: 'source_rejected',
        message: `Hosted media TUS chunk was rejected with HTTP ${response.status}.`,
        resumeAvailable: true,
        retryable: false,
        targetUrl: input.uploadUrl,
        totalBytes: input.fingerprint.sizeBytes,
        transferredBytes: input.startOffset,
        userAction: 'Check account permissions before retrying.',
      });
    }
    const confirmedOffset = Number(response.headers.get('upload-offset'));
    if (confirmedOffset !== input.endOffset) {
      throw transferError({
        checkpointId: input.checkpointId,
        code: 'integrity_mismatch',
        message:
          'Hosted media TUS chunk response did not confirm the expected offset.',
        resumeAvailable: true,
        retryable: false,
        targetUrl: input.uploadUrl,
        totalBytes: input.fingerprint.sizeBytes,
        transferredBytes: input.startOffset,
        userAction:
          'Start a new operation; the upload session offset is inconsistent.',
      });
    }
    return confirmedOffset;
  } catch (error) {
    if (error instanceof HostedMediaTransferError) throw error;
    throw transferError({
      cause: error,
      checkpointId: input.checkpointId,
      code: controller.signal.aborted ? 'idle_timeout' : 'source_rejected',
      message: controller.signal.aborted
        ? 'Hosted media TUS chunk stalled without byte progress.'
        : 'Hosted media TUS chunk failed due to a network error.',
      resumeAvailable: true,
      retryable: true,
      targetUrl: input.uploadUrl,
      totalBytes: input.fingerprint.sizeBytes,
      transferredBytes: input.startOffset,
      userAction:
        'Run the same command again to resume from the confirmed offset.',
    });
  } finally {
    source.destroy();
    progressStream.destroy();
    if (idleTimer) clearTimeout(idleTimer);
  }
}

async function fetchWithConnectTimeout(input: {
  checkpointId: string;
  fetchFn: typeof fetch;
  init: RequestInit;
  targetUrl: string;
  timeoutMs: number;
  totalBytes: number;
  transferredBytes: number;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    return await input.fetchFn(input.targetUrl, {
      ...input.init,
      redirect: 'error',
      signal: controller.signal,
    });
  } catch (error) {
    throw transferError({
      cause: error,
      checkpointId: input.checkpointId,
      code: controller.signal.aborted ? 'connect_timeout' : 'source_rejected',
      message: controller.signal.aborted
        ? 'Hosted media transfer connection timed out.'
        : 'Hosted media transfer request failed.',
      resumeAvailable: input.transferredBytes > 0,
      retryable: true,
      targetUrl: input.targetUrl,
      totalBytes: input.totalBytes,
      transferredBytes: input.transferredBytes,
      userAction: 'Retry the same command.',
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function assertFingerprintMatches(
  absolutePath: string,
  fingerprint: MediaFileFingerprint,
  verifyHash = false,
) {
  const current = await stat(absolutePath);
  if (
    !current.isFile() ||
    current.size !== fingerprint.sizeBytes ||
    current.mtimeMs !== fingerprint.mtimeMs ||
    (verifyHash &&
      (await sha256File(absolutePath)) !== fingerprint.contentSha256)
  ) {
    throw transferError({
      checkpointId: buildMediaTransferCheckpointId({
        fingerprint,
        operationId: 'file-integrity-check',
      }),
      code: 'integrity_mismatch',
      message: 'Hosted media source changed after its fingerprint was created.',
      resumeAvailable: false,
      retryable: false,
      targetUrl: 'file://local',
      totalBytes: fingerprint.sizeBytes,
      transferredBytes: 0,
      userAction: 'Start a new operation for the changed file.',
    });
  }
}

function encodeTusMetadata(metadata: Record<string, string>) {
  return Object.entries(metadata)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',');
}

function sameFingerprint(
  left: MediaFileFingerprint,
  right: MediaFileFingerprint,
) {
  return (
    left.contentSha256 === right.contentSha256 &&
    left.mtimeMs === right.mtimeMs &&
    left.sizeBytes === right.sizeBytes
  );
}

function checkpointFilePath(checkpointId: string) {
  return path.join(
    getPostPlusConfigDir(),
    'media-transfers',
    `${checkpointId}.json`,
  );
}

function emptyCheckpointFile(): UploadCheckpointFile {
  return {
    entries: {},
    schemaVersion: 'postplus-media-transfer-checkpoints/v1',
  };
}

async function readDownloadCheckpoint(
  checkpointPath: string,
): Promise<DownloadCheckpoint | null> {
  try {
    const parsed = JSON.parse(
      await readFile(checkpointPath, 'utf8'),
    ) as Partial<DownloadCheckpoint>;
    if (
      !parsed ||
      typeof parsed.checkpointId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(parsed.checkpointId) ||
      typeof parsed.sourceHash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(parsed.sourceHash) ||
      !Number.isSafeInteger(parsed.receivedBytes) ||
      !Number.isSafeInteger(parsed.totalBytes) ||
      parsed.receivedBytes! < 0 ||
      parsed.totalBytes! <= 0 ||
      parsed.totalBytes! > DOWNLOAD_LIMIT_BYTES ||
      parsed.receivedBytes! > parsed.totalBytes! ||
      (parsed.etag !== null && typeof parsed.etag !== 'string') ||
      (parsed.lastModified !== null &&
        (typeof parsed.lastModified !== 'string' ||
          !Number.isFinite(Date.parse(parsed.lastModified)))) ||
      (parsed.etag !== null && !/^"[^"]*"$/u.test(parsed.etag!)) ||
      (!parsed.etag && !parsed.lastModified)
    ) {
      throw new Error('invalid checkpoint shape');
    }
    return parsed as DownloadCheckpoint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('PostPlus media download checkpoint is unreadable.', {
      cause: error,
    });
  }
}

async function writeDownloadCheckpoint(
  checkpointPath: string,
  checkpoint: DownloadCheckpoint,
) {
  const temporary = `${checkpointPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, {
      encoding: 'utf8',
      mode: CHECKPOINT_FILE_MODE,
    });
    await rename(temporary, checkpointPath);
    await chmod(checkpointPath, CHECKPOINT_FILE_MODE);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error(
      'Unable to persist the PostPlus media download checkpoint.',
      {
        cause: error,
      },
    );
  }
}

function resolveDownloadResponseShape(input: {
  checkpoint: DownloadCheckpoint | null;
  response: Response;
}):
  | {
      etag: string | null;
      lastModified: string | null;
      resumeSupported: boolean;
      totalBytes: number | null;
    }
  | {
      detail: string;
      error: 'integrity_mismatch' | 'source_rejected';
    } {
  const rawEtag = input.response.headers.get('etag');
  const etag = rawEtag && /^"[^"]*"$/u.test(rawEtag) ? rawEtag : null;
  const rawModified = input.response.headers.get('last-modified');
  const lastModified =
    rawModified && Number.isFinite(Date.parse(rawModified))
      ? rawModified
      : null;
  if (
    input.response.headers.get('content-encoding') &&
    input.response.headers.get('content-encoding') !== 'identity'
  ) {
    return {
      detail: 'Encoded media bytes cannot be safely matched to byte ranges.',
      error: 'source_rejected',
    };
  }
  if (input.checkpoint) {
    if (input.response.status !== 206) {
      return {
        detail:
          'The remote server did not honor the requested byte range or its validator changed.',
        error: 'source_rejected',
      };
    }
    const contentRange = parseContentRange(
      input.response.headers.get('content-range'),
    );
    if (
      !contentRange ||
      contentRange.start !== input.checkpoint.receivedBytes ||
      contentRange.total !== input.checkpoint.totalBytes ||
      (input.checkpoint.etag && etag !== input.checkpoint.etag) ||
      (input.checkpoint.lastModified &&
        lastModified !== input.checkpoint.lastModified)
    ) {
      return {
        detail:
          'The resumed response does not match the checkpoint range or validator.',
        error: 'integrity_mismatch',
      };
    }
    return {
      etag,
      lastModified,
      resumeSupported: true,
      totalBytes: contentRange.total,
    };
  }

  const contentRange = parseContentRange(
    input.response.headers.get('content-range'),
  );
  if (input.response.status === 206 && contentRange?.start !== 0) {
    return {
      detail: 'The initial response started at a non-zero byte offset.',
      error: 'integrity_mismatch',
    };
  }
  const contentLength = Number(input.response.headers.get('content-length'));
  const totalBytes = contentRange?.total ?? contentLength;
  const trustworthyTotal =
    Number.isSafeInteger(totalBytes) && totalBytes > 0 ? totalBytes : null;
  const acceptsRanges =
    input.response.headers.get('accept-ranges')?.toLowerCase() === 'bytes';
  return {
    etag,
    lastModified,
    resumeSupported: Boolean(
      trustworthyTotal !== null && acceptsRanges && (etag || lastModified),
    ),
    totalBytes: trustworthyTotal,
  };
}

function parseContentRange(value: string | null) {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  ) {
    return null;
  }
  return { end, start, total };
}

async function commitDownloadedFile(input: {
  absoluteOutput: string;
  checkpointId: string;
  checkpointPath: string;
  partialOutput: string;
  targetUrl: string;
  totalBytes: number;
}) {
  try {
    await rename(input.partialOutput, input.absoluteOutput);
  } catch (error) {
    throw downloadError({
      cause: error,
      checkpointId: input.checkpointId,
      code: 'source_rejected',
      resumeAvailable: true,
      retryable: true,
      stage: 'commit-output',
      targetUrl: input.targetUrl,
      totalBytes: input.totalBytes,
      transferredBytes: input.totalBytes,
      userAction:
        'Retry the same command to commit the completed partial file.',
    });
  }
  try {
    await rm(input.checkpointPath, { force: true });
  } catch (error) {
    throw downloadError({
      cause: error,
      checkpointId: input.checkpointId,
      code: 'source_rejected',
      resumeAvailable: false,
      retryable: false,
      stage: 'commit-output',
      targetUrl: input.targetUrl,
      totalBytes: input.totalBytes,
      transferredBytes: input.totalBytes,
      userAction:
        'Output is already committed; preserve the output and remove the stale local checkpoint after resolving filesystem permissions. Do not download again.',
    });
  }
}

function downloadError(
  input: ConstructorParameters<typeof HostedMediaDownloadError>[0],
) {
  return new HostedMediaDownloadError(input);
}

function isSafeTransferEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}
function isStoredTargetIdentity(
  value: string,
  mediaReference: string,
): boolean {
  try {
    const target = JSON.parse(value);
    if (
      !Array.isArray(target) ||
      ![3, 4].includes(target.length) ||
      !target.every((v) => typeof v === 'string' && v) ||
      !isSafeTransferEndpoint(target[1]) ||
      new URL(target[1]).origin !== target[1]
    )
      return false;
    if (target.length === 3) return target[2] === mediaReference;
    const reference = new URL(mediaReference);
    return (
      reference.protocol === 'postplus-media:' &&
      reference.hostname === target[2] &&
      decodeURIComponent(reference.pathname.slice(1)) === target[3]
    );
  } catch {
    return false;
  }
}

function isStoredTusDescriptor(
  value: unknown,
): value is Extract<SignedHostedUpload, { method: 'TUS' }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const strings = (item: unknown): item is Record<string, string> =>
    Boolean(
      item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        Object.values(item).every((x) => typeof x === 'string'),
    );
  if (
    v.method !== 'TUS' ||
    typeof v.url !== 'string' ||
    !strings(v.requiredHeaders) ||
    !strings(v.metadata) ||
    !v.metadata.bucketName ||
    !v.metadata.objectName ||
    !Number.isSafeInteger(v.chunkSizeBytes) ||
    Number(v.chunkSizeBytes) <= 0 ||
    !Number.isFinite(v.expiresInSeconds) ||
    Number(v.expiresInSeconds) <= 0
  )
    return false;
  return isSafeTransferEndpoint(v.url);
}

async function readCheckpointFile(
  checkpointId: string,
): Promise<UploadCheckpointFile> {
  try {
    const parsed = JSON.parse(
      await readFile(checkpointFilePath(checkpointId), 'utf8'),
    ) as Partial<UploadCheckpointFile>;
    if (
      !parsed ||
      parsed.schemaVersion !== 'postplus-media-transfer-checkpoints/v1' ||
      !parsed.entries ||
      typeof parsed.entries !== 'object'
    ) {
      throw new Error('Invalid media upload checkpoint schema.');
    }
    if (
      Array.isArray(parsed.entries) ||
      Object.entries(parsed.entries).some(
        ([key, entry]) =>
          key !== checkpointId ||
          !entry ||
          typeof entry !== 'object' ||
          typeof entry.operationId !== 'string' ||
          !entry.operationId ||
          createHash('sha256').update(entry.operationId).digest('hex') !==
            key ||
          typeof entry.uploadUrl !== 'string' ||
          typeof entry.targetIdentity !== 'string' ||
          typeof entry.mediaReference !== 'string' ||
          !entry.mediaReference.startsWith('postplus-media://') ||
          !isStoredTargetIdentity(entry.targetIdentity, entry.mediaReference) ||
          !isStoredTusDescriptor(entry.signedUpload) ||
          !Number.isFinite(entry.expiresAt) ||
          !Number.isSafeInteger(entry.confirmedOffset) ||
          entry.confirmedOffset < 0 ||
          !entry.fingerprint ||
          !/^[a-f0-9]{64}$/.test(entry.fingerprint.contentSha256) ||
          !Number.isSafeInteger(entry.fingerprint.sizeBytes) ||
          entry.fingerprint.sizeBytes <= 0 ||
          entry.confirmedOffset > entry.fingerprint.sizeBytes ||
          !Number.isFinite(entry.fingerprint.mtimeMs),
      )
    )
      throw new Error('Invalid media upload checkpoint entry.');
    if (Object.hasOwn(parsed, 'completed')) {
      const c = parsed.completed;
      if (
        Object.keys(parsed.entries).length ||
        !c ||
        typeof c !== 'object' ||
        typeof c.operationId !== 'string' ||
        createHash('sha256').update(c.operationId).digest('hex') !==
          checkpointId ||
        typeof c.targetIdentity !== 'string' ||
        typeof c.mediaReference !== 'string' ||
        !c.mediaReference.startsWith('postplus-media://') ||
        !isStoredTargetIdentity(c.targetIdentity, c.mediaReference) ||
        !c.fingerprint ||
        !/^[a-f0-9]{64}$/u.test(c.fingerprint.contentSha256) ||
        !Number.isFinite(c.fingerprint.mtimeMs) ||
        !Number.isSafeInteger(c.fingerprint.sizeBytes) ||
        c.fingerprint.sizeBytes <= 0
      )
        throw new Error('Invalid completed media upload checkpoint.');
    }
    return {
      ...(parsed.completed ? { completed: parsed.completed } : {}),
      entries: parsed.entries,
      schemaVersion: 'postplus-media-transfer-checkpoints/v1',
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyCheckpointFile();
    }
    throw new Error('PostPlus media transfer checkpoint file is unreadable.', {
      cause: error,
    });
  }
}

async function writeCheckpointFile(
  checkpoints: UploadCheckpointFile,
  checkpointId: string,
) {
  const target = checkpointFilePath(checkpointId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(target), 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(checkpoints, null, 2)}\n`, {
      encoding: 'utf8',
      mode: CHECKPOINT_FILE_MODE,
    });
    await rename(temporary, target);
    await chmod(target, CHECKPOINT_FILE_MODE);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error(
      'Unable to persist the PostPlus media transfer checkpoint.',
      {
        cause: error,
      },
    );
  }
}

function transferError(
  input: ConstructorParameters<typeof HostedMediaTransferError>[0],
) {
  return new HostedMediaTransferError(input);
}

function safeTargetHost(targetUrl: string) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.hostname || 'local';
  } catch {
    return 'unknown';
  }
}
