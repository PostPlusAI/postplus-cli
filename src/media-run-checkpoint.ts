// Durable CLI recovery identity shared by video analysis and media generation.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { PostPlusFailure } from './failure-contract.js';
import { resolveFreshRemoteAuth } from './auth-session.js';
import { PostPlusClientUpgradeRequiredError } from './client-compatibility.js';
import {
  type HostedRequestContext,
  shellQuoteArg,
  writeResult,
} from './hosted-command-runtime.js';
import { getPostPlusConfigDir, readLocalConfig } from './local-state.js';
import type { VideoTransferState } from './media-video-transfer.js';
import type { VisualFrameRange } from './media-video-contact-sheet.js';

// Hosted status and fees remain authoritative. Video checkpoints additionally
// retain private local transport state so a resume never repeats paid work.
export type MediaRunCheckpoint = {
  schemaVersion: 1;
  accountId: string;
  apiOrigin: string;
  capability: 'video-analysis' | 'media-generation';
  operationId: string;
  handle?: string;
  generationRequest?: {
    endpointKey: string;
    input: Record<string, unknown>;
    skillName: string;
  };
  generationSubmissionAttempted?: true;
  videoRequest?: {
    source: string;
    prompt?: string;
    skill: string;
    videoSeconds?: number;
    downloadOnly?: boolean;
    contactSheet?: VisualFrameRange;
  };
  videoTransfer?: VideoTransferState;
  analysisSubmissionAttempted?: true;
};

export type PreparedMediaCheckpoint = {
  filePath: string;
  record: MediaRunCheckpoint;
  resumeCommand: string;
};

export function buildCheckpointResume(
  filePath: string,
  outputPath: string | null,
) {
  return `postplus media poll --resume-from ${shellQuoteArg(filePath)}${
    outputPath ? ` --output ${shellQuoteArg(outputPath)}` : ''
  }`;
}

// An upgrade during media work must not replay an argv that mints a new id.
// The normal resume boundary validates the durable file and account again; a
// missing/corrupt checkpoint stops there without creating replacement work.
export function bindMediaCheckpointUpgradeRecovery(
  error: unknown,
  checkpoint: PreparedMediaCheckpoint | null,
  outputPath: string | null,
  json: boolean,
  recoveryArgs?: string[],
): never {
  if (error instanceof PostPlusClientUpgradeRequiredError && checkpoint) {
    error.recoveryArgs = recoveryArgs ?? [
      'media', 'poll', '--resume-from', checkpoint.filePath,
      ...(outputPath ? ['--output', outputPath] : []),
      ...(json ? ['--json'] : []),
    ];
  }
  throw error;
}

async function currentMediaCheckpointOwner() {
  const auth = await resolveFreshRemoteAuth();
  const config = await readLocalConfig();
  const accountId = config?.accountId ?? config?.userId;
  if (!accountId)
    throw new Error(
      'Run postplus auth login to establish the account before submitting media.',
    );
  return { accountId, apiOrigin: new URL(auth.apiBaseUrl).origin };
}

export async function prepareMediaRunCheckpoint(
  capability: MediaRunCheckpoint['capability'],
  operationId: string,
  outputPath: string | null,
  context: HostedRequestContext | undefined,
  generationRequest?: MediaRunCheckpoint['generationRequest'],
): Promise<PreparedMediaCheckpoint | null> {
  // Library callers already own the operation id and must not touch disk.
  if (context) return null;
  const owner = await currentMediaCheckpointOwner();
  let record: MediaRunCheckpoint = {
    schemaVersion: 1,
    ...owner,
    capability,
    operationId,
  };
  // Identity hashing stays independent of the private input snapshot.
  const key = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  const filePath = path.join(
    getPostPlusConfigDir(),
    'media-runs',
    `${key}.json`,
  );
  if (outputPath && path.resolve(outputPath) === filePath) {
    throw new Error(
      'The result output must not replace the media recovery checkpoint.',
    );
  }
  // Preserve a previously prepared operation, including any uncertain submit.
  let shouldSave = false;
  try {
    const existing = await readMediaRunCheckpoint(filePath, context);
    if (
      existing.operationId !== operationId ||
      existing.capability !== capability
    )
      throw new Error('Media checkpoint identity mismatch.');
    record = existing;
  } catch (error) {
    if (
      !(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
    )
      throw error;
    // The first durable checkpoint includes the full generation intent below.
    shouldSave = true;
  }
  if (generationRequest) {
    if (record.generationRequest && JSON.stringify(record.generationRequest) !== JSON.stringify(generationRequest))
      throw new Error('The saved media generation request differs from this submission. Resume its original checkpoint.');
    if (!record.generationRequest) shouldSave = true;
    record.generationRequest = generationRequest;
  }
  if (Buffer.byteLength(JSON.stringify(record)) > 8 * 1024 * 1024)
    throw new Error('The saved media request exceeds the recovery checkpoint limit. No task was submitted.');
  if (shouldSave) await writeResult(record, filePath, false);
  const resumeCommand = buildCheckpointResume(filePath, outputPath);
  process.stderr.write(
    `Media operation prepared: operationId=${operationId}\nResume: ${resumeCommand}\n`,
  );
  return { filePath, record, resumeCommand };
}

export async function acknowledgeMediaRunCheckpoint(
  checkpoint: PreparedMediaCheckpoint | null,
  handle: string | null,
) {
  if (checkpoint && handle) {
    checkpoint.record.handle = handle;
    await writeResult(
      { ...checkpoint.record, handle },
      checkpoint.filePath,
      false,
    );
  }
}

export async function readMediaRunCheckpoint(
  filePath: string,
  context: HostedRequestContext | undefined,
): Promise<MediaRunCheckpoint> {
  if (context)
    throw new Error(
      '--resume-from is CLI-only; library callers query the original operation id directly.',
    );
  const info = await stat(filePath);
  if (!info.isFile() || info.size > 8 * 1024 * 1024)
    throw new Error('Invalid media recovery checkpoint.');
  // Read errors retain their filesystem identity, especially ENOENT used by
  // first preparation. Invalid JSON must never be treated as an absent record.
  const raw = await readFile(filePath, 'utf8');
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new PostPlusFailure('Invalid media recovery checkpoint: JSON is invalid or truncated.', {
      code: 'postplus_media_checkpoint_invalid',
      stage: 'media-checkpoint-read',
      service: 'filesystem',
      retryable: false,
      resumeAvailable: false,
      action: 'Preserve this checkpoint and contact PostPlus support to recover the original operation; do not delete it or submit a replacement task.',
    }, {
      // Native JSON errors can quote private checkpoint values. Preserve the
      // error category without exposing prompts or upload credentials.
      cause: new SyntaxError('Invalid or truncated JSON in the media recovery checkpoint.'),
    });
  }
  if (!record || typeof record !== 'object' || Array.isArray(record))
    throw new Error('Invalid media recovery checkpoint.');
  const data = record as Record<string, unknown>;
  if (
    data.schemaVersion !== 1 ||
    !['video-analysis', 'media-generation'].includes(String(data.capability)) ||
    !['accountId', 'apiOrigin', 'operationId'].every(
      (key) =>
        typeof data[key] === 'string' && (data[key] as string).length > 0,
    ) ||
    (data.handle !== undefined &&
      (typeof data.handle !== 'string' || !data.handle)) ||
    Object.keys(data).some(
      (key) =>
        ![
          'schemaVersion',
          'accountId',
          'apiOrigin',
          'capability',
          'operationId',
          'handle',
          'generationRequest',
          'generationSubmissionAttempted',
          'videoRequest',
          'videoTransfer',
          'analysisSubmissionAttempted',
        ].includes(key),
    )
  )
    throw new Error('Invalid media recovery checkpoint.');
  if (data.generationRequest !== undefined) {
    const request = data.generationRequest as Record<string, unknown> | null;
    if (data.capability !== 'media-generation' || !request || typeof request !== 'object' ||
        Array.isArray(request) || typeof request.endpointKey !== 'string' || !request.endpointKey ||
        typeof request.skillName !== 'string' || !request.skillName ||
        !request.input || typeof request.input !== 'object' || Array.isArray(request.input) ||
        Object.keys(request).some(key => !['endpointKey', 'input', 'skillName'].includes(key)))
      throw new Error('Invalid saved media generation request.');
  }
  if (data.generationSubmissionAttempted !== undefined &&
      (data.generationSubmissionAttempted !== true || !data.generationRequest))
    throw new Error('Invalid media generation submission checkpoint.');
  if (data.videoRequest !== undefined) {
    const request = data.videoRequest;
    if (
      data.capability !== 'video-analysis' ||
      !request ||
      typeof request !== 'object' ||
      !('source' in request) ||
      typeof request.source !== 'string' ||
      !('skill' in request) ||
      typeof request.skill !== 'string'
    )
      throw new Error('Invalid video recovery input.');
    if ('contactSheet' in request && request.contactSheet !== undefined) {
      const range = request.contactSheet;
      if (!('downloadOnly' in request) || request.downloadOnly !== true ||
        !range || typeof range !== 'object' || Array.isArray(range) ||
        Object.entries(range).some(([key, value]) =>
          !['startSeconds', 'endSeconds', 'frameIntervalSeconds'].includes(key) ||
          typeof value !== 'number' || !Number.isFinite(value) || value < 0) ||
        ('frameIntervalSeconds' in range && range.frameIntervalSeconds === 0) ||
        ('endSeconds' in range && Number(range.endSeconds) <= Number('startSeconds' in range ? range.startSeconds : 0)))
        throw new Error('Invalid local frame recovery input.');
    }
  }
  if (
    data.analysisSubmissionAttempted !== undefined &&
    data.analysisSubmissionAttempted !== true
  )
    throw new Error('Invalid video submission checkpoint.');
  const owner = await currentMediaCheckpointOwner();
  if (
    owner.accountId !== data.accountId ||
    owner.apiOrigin !== data.apiOrigin
  ) {
    throw new Error(
      'This media operation belongs to another account or environment. Sign in to its original account/environment; do not resubmit.',
    );
  }
  return data as MediaRunCheckpoint;
}
