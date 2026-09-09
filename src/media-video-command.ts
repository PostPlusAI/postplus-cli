// Video analysis orchestration: retain local evidence, submit once, resume the same operation.
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { HOSTED_MEDIA_REFERENCE_URI_PREFIX } from './generated/hosted-field-validation-core.generated.js';
import {
  isHostedCompatibilityRequestError,
  HostedProductRequestError,
  HostedQuoteConfirmationRequiredError,
  type HostedRequestContext,
  assertSuccessfulMediaTerminal,
  dispatchHostedCommand,
  isTerminalRunStatus,
  pollHostedRunUntilSettled,
  postHostedJson,
  readHostedProductError,
  readHostedUploadOutput,
  readMediaPollRun,
  readMediaRunResult,
  shellQuoteArg,
  writeResult,
} from './hosted-command-runtime.js';
import { getPostPlusConfigDir } from './local-state.js';
import {
  type MediaRunCheckpoint,
  type PreparedMediaCheckpoint,
  acknowledgeMediaRunCheckpoint,
  buildCheckpointResume,
  bindMediaCheckpointUpgradeRecovery,
  prepareMediaRunCheckpoint,
} from './media-run-checkpoint.js';
import {
  type VideoSourceFailure,
  type VideoTransferRequest,
  prepareVideoAnalysisInput,
} from './media-video-transfer.js';
import { formatNetworkErrorChain } from './network-diagnostics.js';
import { readLargeCreditQuoteConfirmationChallenge } from './quote-confirmation.js';

const videoTransferErrors = {
  isSourceSubmissionRejected: (error: unknown) =>
    isHostedCompatibilityRequestError(error) ||
    (error instanceof HostedProductRequestError &&
      error.productError.sourceSubmissionRejected === true),
  isRequestRejectedBeforeExecution: (error: unknown) =>
    isHostedCompatibilityRequestError(error),
  isHostedRequestError: (error: unknown) =>
    isHostedCompatibilityRequestError(error) ||
    error instanceof HostedProductRequestError ||
    error instanceof HostedQuoteConfirmationRequiredError,
  sourceFailureError: (failure: VideoSourceFailure) =>
    new HostedProductRequestError({
      code:
        failure.error?.code && /^[a-z][a-z0-9_]+$/u.test(failure.error.code)
          ? failure.error.code
          : 'media_video_source_failed',
      message: failure.error?.message
        ? formatNetworkErrorChain(new Error(failure.error.message))
        : 'The requested source did not return a usable video.',
      layer: 'source_acquisition',
      operationId: failure.sourceOperationId ?? null,
      userMessageRule: null,
      stage: 'resolving_source',
      retryable: false,
      userAction:
        'Review the source access or media-type error. Keep this operation and any recorded collection charges; do not repeat an uncertain collection.',
    }),
};

// A paused existing run is not a rejected submission. Keep its durable identity.
async function assertVideoQuoteNotRequired(
  payload: unknown,
  checkpoint?: Pick<PreparedMediaCheckpoint, 'record' | 'filePath'> | null,
) {
  const run = readMediaRunResult(payload);
  if (run.error?.code !== 'postplus_cli_quote_confirmation_required') return;
  const challenge = readLargeCreditQuoteConfirmationChallenge(run.error);
  if (
    !challenge ||
    !run.id ||
    (checkpoint && challenge.operationId !== checkpoint.record.operationId)
  )
    throw new Error(
      'Video task returned an invalid quote confirmation challenge. Query the same operation.',
    );
  if (checkpoint) {
    checkpoint.record.handle = run.id;
    checkpoint.record.analysisSubmissionAttempted = true;
    checkpoint.record.analysisQuoteRequired = true;
    await writeResult(checkpoint.record, checkpoint.filePath, false);
  }
  throw Object.assign(
    new HostedQuoteConfirmationRequiredError(
      'Video analysis is paused pending quote confirmation. Confirm and rerun the original input with the same operation id.',
      challenge,
    ),
    {
      capability: 'video-analysis',
      handle: run.id,
      operationId: challenge.operationId,
    },
  );
}

export async function executeVideoAnalysis(input: {
  body: {
    capability: string;
    operation: string;
    modelKey: string;
    input: Record<string, unknown>;
    estimatedUsage?: { videoSeconds: number };
    operationId: string;
    quoteConfirmationToken?: string;
  };
  originalSource: string;
  prompt?: string;
  skillName: string;
  outputPath: string | null;
  json: boolean;
  errorInputLabel: string;
  wait: { pollIntervalMs: number; waitBudgetMs: number };
  context?: HostedRequestContext;
  recoveryArgs: string[];
}): Promise<number | unknown> {
  const {
    body,
    originalSource,
    prompt,
    skillName,
    outputPath,
    json,
    errorInputLabel,
    wait,
    context,
  } = input;
  const estimatedUsage = body.estimatedUsage;
  const checkpoint = await prepareMediaRunCheckpoint(
    'video-analysis',
    body.operationId,
    outputPath,
    context,
  );
  if (checkpoint) {
    const videoRequest = {
      source: originalSource,
      ...(prompt !== undefined ? { prompt } : {}),
      skill: skillName,
      ...(estimatedUsage ? { videoSeconds: estimatedUsage.videoSeconds } : {}),
    };
    if (
      checkpoint.record.videoRequest &&
      JSON.stringify(checkpoint.record.videoRequest) !==
        JSON.stringify(videoRequest)
    )
      throw new Error(
        'This operation belongs to different video input. Resume its original checkpoint.',
      );
    checkpoint.record.videoRequest = videoRequest;
    await writeResult(checkpoint.record, checkpoint.filePath, false);
  }
  let lastStage: string | null = null;
  let acceptedRunId: string | null = null;
  let terminalObserved = false;
  let transferProductError = false;
  let recoveryCommand: string | null = checkpoint?.resumeCommand ?? null;
  return dispatchHostedCommand(
    {
      request: async () => {
        const submissionAttempted =
          checkpoint?.record.analysisSubmissionAttempted === true;
        const confirmingExistingRun =
          submissionAttempted &&
          checkpoint?.record.analysisQuoteRequired === true &&
          Boolean(body.quoteConfirmationToken);
        if (confirmingExistingRun) {
          const transfer = checkpoint!.record.videoTransfer;
          if (
            !transfer?.uploadToken ||
            !transfer.fileName ||
            !transfer.metadata
          )
            throw new Error(
              'The original uploaded video reference is missing. Query the same operation.',
            );
          body.input.video = `postplus-video://${transfer.uploadToken}/${transfer.fileName}`;
          body.estimatedUsage = {
            videoSeconds: transfer.metadata.durationSeconds,
          };
        }
        if (checkpoint && !submissionAttempted) {
          const prepared = await prepareVideoAnalysisInput({
            ...videoTransferErrors,
            source: originalSource,
            operationId: body.operationId,
            directory: path.join(
              getPostPlusConfigDir(),
              'media-evidence',
              path.basename(checkpoint.filePath, '.json'),
            ),
            state: checkpoint.record.videoTransfer,
            saveState: async (state) => {
              checkpoint.record.videoTransfer = state;
              await writeResult(checkpoint.record, checkpoint.filePath, false);
            },
            request: (request) =>
              requestVideoTransfer(request, skillName, context),
            onProgress: (message) => process.stderr.write(`${message}\n`),
          }).catch((error: unknown) => {
            // The private checkpoint is separate from the requested result file.
            // A structured transfer failure must still reach that result file.
            transferProductError = error instanceof HostedProductRequestError;
            throw error;
          });
          if (!prepared.videoReference)
            throw new Error('The video upload has no analysis reference.');
          body.input.video = prepared.videoReference;
          body.estimatedUsage = {
            videoSeconds: prepared.metadata.durationSeconds,
          };
          process.stderr.write(`Local video evidence: ${prepared.filePath}\n`);
          checkpoint.record.analysisSubmissionAttempted = true;
          await writeResult(checkpoint.record, checkpoint.filePath, false);
        }
        let submitted: unknown;
        try {
          submitted = await postHostedJson({
            body:
              submissionAttempted && !confirmingExistingRun
                ? {
                    capability: 'video-analysis',
                    operation: 'status',
                    sourceOperationId: body.operationId,
                    operationId: `${body.operationId}:status`,
                  }
                : body,
            pathName: '/api/postplus-cli/hosted/capability',
            skillName:
              submissionAttempted && !confirmingExistingRun ? null : skillName,
            context,
          });
        } catch (error) {
          // Compatibility and synchronous quote gates reject before execution.
          // A failed read-only input count also proves no analysis was created.
          // Unknown transport failures must retain the submission marker.
          if (
            checkpoint &&
            !submissionAttempted &&
            (isHostedCompatibilityRequestError(error) ||
              error instanceof HostedQuoteConfirmationRequiredError ||
              (error instanceof HostedProductRequestError &&
                (error.productError.analysisSubmissionRejected === true ||
                  error.productError.code ===
                    'video_analysis_quote_unavailable')))
          ) {
            delete checkpoint.record.analysisSubmissionAttempted;
            await writeResult(checkpoint.record, checkpoint.filePath, false);
          }
          throw error;
        }
        await assertVideoQuoteNotRequired(submitted, checkpoint);
        if (confirmingExistingRun && checkpoint) {
          delete checkpoint.record.analysisQuoteRequired;
          await writeResult(checkpoint.record, checkpoint.filePath, false);
        }
        emitVideoAnalysisProgress(submitted, (stage) => {
          if (stage === lastStage) return false;
          lastStage = stage;
          return true;
        });
        const run = readMediaRunResult(submitted);
        terminalObserved =
          run.status !== null && isTerminalRunStatus(run.status);
        await acknowledgeMediaRunCheckpoint(checkpoint, run.id);
        if (!run.status || isTerminalRunStatus(run.status)) {
          return normalizeCompletedVideoAnalysisPayload(submitted);
        }
        if (!run.id) {
          throw new Error(
            `Video analysis returned non-terminal status ${run.status} without a run handle.`,
          );
        }
        acceptedRunId = run.id;
        recoveryCommand = extractVideoAnalysisResume(submitted, outputPath);
        if (!context) {
          // Publish the handle before any fallible disk write or status read.
          // The protected checkpoint retains transport recovery state; the hosted
          // run remains authoritative for analysis status and billing.
          process.stderr.write(
            `Video analysis accepted: operationId=${body.operationId}\nResume: ${recoveryCommand}\n`,
          );
          if (outputPath) {
            await writeResult(
              {
                capability: 'video-analysis',
                id: run.id,
                operationId: body.operationId,
                stage: run.stage,
                status: run.status,
              },
              outputPath,
              false,
            );
          }
        }
        let settled: unknown;
        try {
          settled = await pollHostedRunUntilSettled({
            retryTransientErrors: true,
            pollIntervalMs: wait.pollIntervalMs,
            pollOnce: async (timeoutMs) => {
              const payload = await postHostedJson({
                timeoutMs,
                body: {
                  capability: 'video-analysis',
                  handle: run.id,
                  operation: 'status',
                  operationId: `postplus-cli:media:video-analysis:status:${randomUUID()}`,
                },
                pathName: '/api/postplus-cli/hosted/capability',
                skillName: null,
                context,
              });
              await assertVideoQuoteNotRequired(payload, checkpoint);
              return payload;
            },
            readStatus: (payload) => {
              emitVideoAnalysisProgress(payload, (nextStage) => {
                if (nextStage === lastStage) return false;
                lastStage = nextStage;
                return true;
              });
              return readMediaRunResult(payload).status;
            },
            waitBudgetMs: wait.waitBudgetMs,
          });
        } catch (error) {
          // In-process callers receive the same stable identity as the CLI's
          // recovery hint, even when a network exception has no response body.
          if (error instanceof Error) {
            Object.assign(error, {
              capability: 'video-analysis',
              handle: run.id,
              operationId: body.operationId,
            });
          }
          throw error;
        }
        const status = readMediaRunResult(settled).status;
        terminalObserved = status !== null && isTerminalRunStatus(status);
        return normalizeCompletedVideoAnalysisPayload(settled);
      },
      errorInputLabel,
      json,
      outputPath,
      preserveOutputOnProductError: () =>
        (!transferProductError && checkpoint !== null) ||
        acceptedRunId !== null ||
        terminalObserved,
      preservedOutputRecovery: () =>
        recoveryCommand
          ? terminalObserved
            ? `Task record: ${recoveryCommand}`
            : `Check the same operation; do not resubmit: ${recoveryCommand}`
          : null,
      asyncResume: (payload) => extractVideoAnalysisResume(payload, outputPath),
    },
    context,
  ).catch((error: unknown) =>
    bindMediaCheckpointUpgradeRecovery(error, checkpoint, outputPath, json, input.recoveryArgs),
  );
}

async function requestVideoTransfer(
  request: VideoTransferRequest,
  skillName: string | null,
  context?: HostedRequestContext,
) {
  if (
    (request.operation === 'resolve-source' ||
      request.operation === 'source-status') &&
    request.input.source?.startsWith(HOSTED_MEDIA_REFERENCE_URI_PREFIX)
  ) {
    const result = await postHostedJson({
      body: {
        capability: 'media-file',
        operation: 'create-read-url',
        file: { mediaReference: request.input.source },
        operationId: `${request.operationId}:source`,
      },
      pathName: '/api/postplus-cli/hosted/capability',
      skillName,
      context,
    });
    const signedUrl = readHostedUploadOutput(result).signedUrl;
    if (typeof signedUrl !== 'string' || !signedUrl.startsWith('https://'))
      throw new Error(
        'Existing media reference did not return a readable HTTPS video URL.',
      );
    return {
      output: {
        status: 'completed',
        source: { kind: 'video', videoCandidates: [{ url: signedUrl }] },
      },
    };
  }
  return postHostedJson({
    body: { capability: 'video-analysis', ...request },
    pathName: '/api/postplus-cli/hosted/capability',
    skillName,
    context,
  });
}

export async function prepareVideoEvidence(
  source: string,
  resume?: PreparedMediaCheckpoint,
) {
  const operationId =
    resume?.record.operationId ?? `postplus-cli:media:prepare:${randomUUID()}`;
  const checkpoint =
    resume ??
    (await prepareMediaRunCheckpoint(
      'video-analysis',
      operationId,
      null,
      undefined,
    ));
  if (!checkpoint)
    throw new Error('Video preparation requires a local checkpoint.');
  checkpoint.record.videoRequest = {
    source,
    skill: 'media-analysis',
    downloadOnly: true,
  };
  await writeResult(checkpoint.record, checkpoint.filePath, false);
  process.stderr.write(`Resume: ${checkpoint.resumeCommand}\n`);
  const prepared = await prepareVideoAnalysisInput({
    ...videoTransferErrors,
    source,
    operationId,
    downloadOnly: true,
    directory: path.join(
      getPostPlusConfigDir(),
      'media-evidence',
      path.basename(checkpoint.filePath, '.json'),
    ),
    state: checkpoint.record.videoTransfer,
    saveState: async (state) => {
      checkpoint.record.videoTransfer = state;
      await writeResult(checkpoint.record, checkpoint.filePath, false);
    },
    request: (request) => requestVideoTransfer(request, 'media-analysis'),
    onProgress: (message) => process.stderr.write(`${message}\n`),
  }).catch((error: unknown) =>
    bindMediaCheckpointUpgradeRecovery(error, checkpoint, null, true),
  );
  return {
    kind: 'video',
    filePath: prepared.filePath,
    metadata: prepared.metadata,
    sourceBilling: prepared.sourceBilling ?? null,
    operationId,
    resumeCommand: checkpoint.resumeCommand,
  };
}

function emitVideoAnalysisProgress(
  payload: unknown,
  shouldEmit: (stage: string) => boolean,
) {
  const run = readMediaRunResult(payload);
  if (!run.stage || !shouldEmit(run.stage)) return;
  const fields = [
    `stage=${run.stage}`,
    `elapsed=${Math.max(0, run.elapsedMs ?? 0)}ms`,
    run.bytes !== null ? `bytes=${run.bytes}` : null,
    run.totalBytes !== null ? `total=${run.totalBytes}` : null,
  ].filter((value): value is string => value !== null);
  process.stderr.write(`${fields.join(' ')}\n`);
}

function normalizeCompletedVideoAnalysisPayload(payload: unknown) {
  assertSuccessfulMediaTerminal(payload);
  if (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).output === 'string'
  ) {
    return (payload as Record<string, string>).output;
  }
  const run = readMediaRunResult(payload);
  if (run.status === 'completed' && !run.markdown) {
    throw new HostedProductRequestError({
      ...readHostedProductError(payload),
      message: 'The completed video task has no Markdown.',
      code: 'video_analysis_result_incomplete',
      stage: run.stage ?? 'completed',
      retryable: false,
      userAction:
        'Query the same run or contact PostPlus support; do not resubmit.',
      ...(run.id ? { runId: run.id } : {}),
    });
  }
  if (!run.markdown || run.status !== 'completed') return payload;
  // Keep the canonical report byte-for-byte; billing belongs on stderr, not
  // inside the Markdown or hidden by the successful-result normalization.
  const billing =
    payload && typeof payload === 'object' && 'billing' in payload
      ? payload.billing
      : null;
  if (
    billing &&
    typeof billing === 'object' &&
    'estimatedOnly' in billing &&
    billing.estimatedOnly === true &&
    'finalizedCredits' in billing &&
    typeof billing.finalizedCredits === 'number' &&
    Number.isFinite(billing.finalizedCredits) &&
    billing.finalizedCredits >= 0
  )
    process.stderr.write(
      `Billing: ${billing.finalizedCredits} PostPlus credits (estimated settlement from the initial reservation; actual usage unconfirmed).\n`,
    );
  return run.markdown;
}

function extractVideoAnalysisResume(
  payload: unknown,
  outputPath: string | null,
) {
  const run = readMediaRunResult(payload);
  if (!run.id || (run.status && isTerminalRunStatus(run.status))) return null;
  return `postplus media poll --handle ${shellQuoteArg(run.id)} --capability video-analysis${
    outputPath ? ` --output ${shellQuoteArg(outputPath)}` : ''
  }`;
}

/** Recovery re-enters the existing CLI input boundary before any new analysis request. */
export async function resumeVideoCheckpoint(input: {
  checkpoint: PreparedMediaCheckpoint;
  outputPath: string | null;
  json: boolean;
  analyze: (args: string[]) => Promise<number | unknown>;
}): Promise<number | unknown> {
  const { checkpoint, outputPath, json, analyze } = input;
  const original = checkpoint.record.videoRequest;
  if (!original || checkpoint.record.analysisSubmissionAttempted)
    throw new Error(
      'Video recovery requires an unsubmitted analysis checkpoint.',
    );
  if (original.downloadOnly) {
    const result = await prepareVideoEvidence(original.source, checkpoint);
    await writeResult(result, outputPath, json);
    return 0;
  }
  return analyze([
    '--video',
    original.source,
    '--skill',
    original.skill,
    '--hosted-operation-id',
    checkpoint.record.operationId,
    ...(original.prompt !== undefined ? ['--prompt', original.prompt] : []),
    ...(original.videoSeconds !== undefined
      ? ['--video-seconds', String(original.videoSeconds)]
      : []),
    ...(outputPath ? ['--output', outputPath] : []),
    ...(json ? ['--json'] : []),
  ]);
}

export async function pollVideoAnalysis(input: {
  handle: string | null;
  checkpoint: MediaRunCheckpoint | null;
  resumePath?: string;
  outputPath: string | null;
  context?: HostedRequestContext;
  json: boolean;
  debug: boolean;
  wait: { pollIntervalMs: number; waitBudgetMs: number };
}): Promise<number | unknown> {
  const { handle, checkpoint, resumePath, outputPath, context, json, debug } =
    input;
  const capability = 'video-analysis';
  const { pollIntervalMs, waitBudgetMs } = input.wait;
  let lastStage: string | null = null;
  let terminalObserved = false;

  const pollOnce = async (timeoutMs?: number) => {
    const payload = await postHostedJson({
      timeoutMs,
      body: {
        capability,
        ...(handle
          ? { handle }
          : { sourceOperationId: checkpoint!.operationId }),
        operation: 'status',
        operationId: `postplus-cli:media:${capability}:status:${randomUUID()}`,
      },
      pathName: '/api/postplus-cli/hosted/capability',
      skillName: null,
      context,
      debug,
    });
    await assertVideoQuoteNotRequired(
      payload,
      checkpoint && resumePath
        ? { record: checkpoint, filePath: resumePath }
        : null,
    );
    return payload;
  };

  return dispatchHostedCommand(
    {
      request: async () => {
        const settled = await pollHostedRunUntilSettled({
          retryTransientErrors: true,
          pollIntervalMs,
          pollOnce,
          readStatus: (payload) => {
            emitVideoAnalysisProgress(payload, (stage) => {
              if (stage === lastStage) return false;
              lastStage = stage;
              return true;
            });
            return readMediaRunResult(payload).status;
          },
          waitBudgetMs,
        });
        const status = readMediaPollRun(settled).status;
        terminalObserved = status !== null && isTerminalRunStatus(status);
        return normalizeCompletedVideoAnalysisPayload(settled);
      },
      errorInputLabel: 'media-poll-handle',
      json,
      outputPath,
      preserveOutputOnProductError: true,
      preservedOutputRecovery: resumePath
        ? () =>
            `${terminalObserved ? 'Task record' : 'Check the same operation; do not resubmit'}: ${buildCheckpointResume(resumePath, outputPath)}`
        : () =>
            `${terminalObserved ? 'Task record' : 'Resume the same run'}: ${extractVideoAnalysisResume({ output: { data: { id: handle } } }, outputPath)}`,
      asyncResume: (payload) => extractVideoAnalysisResume(payload, outputPath),
    },
    context,
  );
}
