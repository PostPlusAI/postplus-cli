// Existing hosted HTTP, product errors, output persistence and bounded status waits.
// This module owns no command routing or provider submission policy.
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import { resolveFreshRemoteAuth } from './auth-session.js';
import {
  type AuthedCloudRequestAuth,
  sendAuthedCloudRequest,
} from './authed-cloud-request.js';
import {
  PostPlusClientUpgradeRequiredError,
  formatPostPlusCompatibilityError,
  isPostPlusClientUpgradePayload,
} from './client-compatibility.js';
import { PostPlusNetworkRequestError } from './network-diagnostics.js';
import {
  type LargeCreditQuoteConfirmationChallenge,
  readLargeCreditQuoteConfirmationChallenge,
} from './quote-confirmation.js';
import { clearUpdateCheckCache } from './update-check.js';

// In-process execution context for the hosted-lib path (src/hosted-lib.ts). When
// present it makes the SAME resolve/dispatch core run without any disk or
// filesystem touch: the POST uses the injected `auth` + `skillsReleaseId` instead
// of `resolveFreshRemoteAuth()`/disk config, the request-json surfaces read the
// envelope from the injected `requestJson` object instead of a `--request <file>`,
// and runHostedCommand returns the parsed payload (throwing the structured errors)
// instead of writing stdout/file/exit-code. When the context is `undefined`
// (the bin path) every code path keeps its current disk/file/stdout behavior.
export type HostedRequestContext = {
  auth: AuthedCloudRequestAuth;
  skillsReleaseId?: string;
  /**
   * The request-json envelope injected in place of a `--request <file>` read.
   * Surfaces that need a body assert it is present and the right shape (object vs
   * array) exactly as the file-read path validated the parsed file contents.
   */
  requestJson?: Record<string, unknown> | unknown[];
};

// Recognized compatibility codes are returned by the hosted route before
// capability execution. Preserve that proof when formatting user guidance.
export class HostedCompatibilityRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'HostedCompatibilityRequestError';
  }
}

// Both typed upgrade responses and the other recognized compatibility gates
// prove rejection before execution. The shell keeps A's typed upgrade payload.
export function isHostedCompatibilityRequestError(
  error: unknown,
): error is HostedCompatibilityRequestError | PostPlusClientUpgradeRequiredError {
  return error instanceof HostedCompatibilityRequestError ||
    error instanceof PostPlusClientUpgradeRequiredError;
}

export class HostedQuoteConfirmationRequiredError extends Error {
  constructor(
    message: string,
    readonly challenge: LargeCreditQuoteConfirmationChallenge,
  ) {
    super(message);
    this.name = 'HostedQuoteConfirmationRequiredError';
  }
}

// Structured hosted product error as returned by the Web boundary. The CLI is a
// pass-through: it must report the stable code, owning layer, and operation id
// verbatim instead of collapsing the failure to a generic message.
type HostedProductErrorUserAction = {
  label: string;
  type: 'open_url';
  url: string;
};

export type HostedProductError = {
  message: string;
  code: string | null;
  layer: string | null;
  operationId: string | null;
  userMessageRule: string | null;
  stage?: string;
  retryable?: boolean;
  userAction?: string | HostedProductErrorUserAction;
  runId?: string;
  sourceSubmissionRejected?: true;
  analysisSubmissionRejected?: true;
};

export class HostedProductRequestError extends Error {
  constructor(
    readonly productError: HostedProductError,
    readonly httpStatus?: number,
    readonly retryAfterMs = 0,
  ) {
    super(formatHostedProductErrorMessage(productError));
    this.name = 'HostedProductRequestError';
  }
}

export async function postHostedJson(input: {
  body: unknown;
  debug?: boolean;
  pathName: string;
  skillName: string | null;
  timeoutMs?: number;
  // When present (the hosted-lib path) the POST uses the injected auth +
  // skillsReleaseId with NO disk read and NO 401-refresh-retry (the eve runtime
  // supplies fresh session auth each turn). When absent (the bin path) the auth
  // is resolved from disk and a single 401 triggers a forced refresh, exactly as
  // before. Either way the body/URL/headers are built identically.
  context?: HostedRequestContext;
}): Promise<unknown> {
  const requestBody = input.body as {
    capability?: unknown;
    operation?: unknown;
  } | null;
  const isMediaStatus =
    requestBody?.operation === 'status' &&
    ['video-analysis', 'media-generation'].includes(
      String(requestBody.capability),
    );
  const signal = isMediaStatus
    ? AbortSignal.timeout(input.timeoutMs ?? 30000)
    : undefined;
  const auth =
    input.context?.auth ?? (await resolveFreshRemoteAuth({ signal }));
  const response = await sendAuthedCloudRequest({
    auth,
    signal,
    body: input.body,
    ...(input.debug !== undefined ? { debug: input.debug } : {}),
    method: 'POST',
    pathName: input.pathName,
    ...(input.context
      ? { skillsReleaseId: input.context.skillsReleaseId ?? null }
      : {
          retryOn401: () =>
            resolveFreshRemoteAuth({ forceRefresh: true, signal }),
        }),
    skillName: input.skillName,
    timeoutMs: input.timeoutMs ?? 120000,
  });

  let payload: unknown;
  try {
    payload = await readJsonResponse(response);
  } catch (error) {
    if (response.ok || !isMediaStatus) {
      if (
        isMediaStatus &&
        error instanceof Error &&
        (error instanceof TypeError ||
          error.name === 'AbortError' ||
          error.name === 'TimeoutError')
      ) {
        throw new PostPlusNetworkRequestError({
          cause: signal?.aborted ? signal.reason : error,
          method: 'POST',
          targetUrl: auth.apiBaseUrl,
          detail: 'The status response stream was interrupted.',
        });
      }
      throw error;
    }
    // A gateway may return HTML or a truncated error body. Keep the HTTP
    // classification without exposing that ungoverned body to the user.
    payload = {
      code: 'postplus_cli_hosted_status_unavailable',
      message: `PostPlus request failed with HTTP ${response.status}.`,
    };
  }
  if (!response.ok) {
    const productError = readHostedProductError(payload);
    const challenge = readLargeCreditQuoteConfirmationChallenge(payload);
    if (challenge) {
      throw new HostedQuoteConfirmationRequiredError(
        productError.message,
        challenge,
      );
    }

    if (isPostPlusClientUpgradePayload(payload)) {
      await clearUpdateCheckCache();
      throw new PostPlusClientUpgradeRequiredError(payload);
    }

    const compatibilityError = formatPostPlusCompatibilityError(payload);
    if (compatibilityError) {
      await clearUpdateCheckCache();
      throw new HostedCompatibilityRequestError(
        compatibilityError,
        productError.code,
      );
    }
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs =
      retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : retryAfter
          ? Date.parse(retryAfter) - Date.now()
          : 0;
    throw new HostedProductRequestError(
      productError,
      response.status,
      Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0,
    );
  }

  return payload;
}

// Single exit path for the BIN hosted command: success writes the result and
// returns 0; a quote challenge writes the challenge file and rethrows actionable
// guidance; a structured product error writes the full error envelope to the
// result JSON and surfaces code/layer/operationId on the terminal, exiting 1.
async function runHostedCommand(input: {
  request: () => Promise<unknown>;
  errorInputLabel: string;
  json: boolean;
  outputPath: string | null;
  // A resume checkpoint is durable input, not an error sink. If a status read
  // fails, keep the last valid handle on disk so the caller can retry after the
  // underlying problem is fixed. --json still receives the structured error on
  // stdout; human mode keeps the existing actionable stderr message.
  preserveOutputOnProductError?: boolean | (() => boolean);
  preservedOutputRecovery?: () => string | null;
  // When an async submit remains pending, render its next safe action. Media
  // keeps its short literal id; research emits only --resume-from <checkpoint>
  // so an agent never rewrites a signed opaque handle. stderr is used in both
  // human and --json modes without changing the server payload on stdout.
  asyncResume?: (payload: unknown) => string | null;
}): Promise<number> {
  let payload: unknown;
  try {
    payload = await input.request();
  } catch (error) {
    if (error instanceof HostedQuoteConfirmationRequiredError) {
      const challengePath = await writeQuoteConfirmationChallenge(error, {
        errorInputLabel: input.errorInputLabel,
        outputPath: input.outputPath,
      });
      throw new Error(
        [
          error.message,
          `Quote confirmation challenge: ${challengePath}`,
          `Confirm: postplus quote confirm --json --challenge-file "${challengePath}"`,
          // The confirmation token is server-signed against the challenged
          // operation id. Re-running without --hosted-operation-id mints a fresh
          // random operation id (see the operationId flag default), so the token
          // would no longer match and the confirmation fails. The rerun MUST pin
          // the same operation id the token is bound to.
          'Then rerun the hosted command with the same operation id the token is bound to:',
          `  --hosted-operation-id ${error.challenge.operationId} --quote-confirmation-token <token>`,
        ].join('\n'),
      );
    }

    if (error instanceof HostedProductRequestError) {
      if (shouldPreserveHostedOutput(input.preserveOutputOnProductError)) {
        if (input.json) {
          await writeResult({ error: error.productError }, null, true);
        }
        writePreservedOutputRecovery(input.preservedOutputRecovery);
      } else {
        await writeResult(
          { error: error.productError },
          input.outputPath,
          input.json,
        );
      }
      process.stderr.write(`${error.message}\n`);
      return 1;
    }

    if (shouldPreserveHostedOutput(input.preserveOutputOnProductError)) {
      writePreservedOutputRecovery(input.preservedOutputRecovery);
    }

    throw error;
  }

  await writeResult(
    payload,
    input.outputPath,
    input.json,
    input.errorInputLabel.startsWith('media-analyze-') ||
      input.errorInputLabel === 'media-poll-handle',
  );

  const resumeCommand = input.asyncResume?.(payload) ?? null;
  if (resumeCommand) {
    process.stderr.write(`Async run pending — resume: ${resumeCommand}\n`);
  }

  return 0;
}

// Single exit path for both BIN and LIB hosted commands. Each dispatch function
// builds the SAME `request` closure (resolve verb -> build envelope -> POST) and
// hands it here. The bin path (no `context`) keeps stdout/file/exit-code behavior
// via runHostedCommand. The lib path (with `context`) returns the parsed payload
// and rethrows the structured HostedProductRequestError / quote-confirmation error
// VERBATIM — no stdout, no file writes, no exit code — so the in-process caller
// surfaces the structured JSON and fails honestly. Because the closure is shared,
// the wire request (URL + body + headers) is byte-identical across both paths.
export async function dispatchHostedCommand(
  input: {
    request: () => Promise<unknown>;
    errorInputLabel: string;
    json: boolean;
    outputPath: string | null;
    preserveOutputOnProductError?: boolean | (() => boolean);
    preservedOutputRecovery?: () => string | null;
    asyncResume?: (payload: unknown) => string | null;
  },
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
  if (!context) {
    return runHostedCommand(input);
  }
  return input.request();
}

function shouldPreserveHostedOutput(
  value: boolean | (() => boolean) | undefined,
): boolean {
  return typeof value === 'function' ? value() : value === true;
}

function writePreservedOutputRecovery(
  buildRecovery: (() => string | null) | undefined,
): void {
  const recovery = buildRecovery?.() ?? null;
  if (recovery) {
    process.stderr.write(`${recovery}\n`);
  }
}

// Resume-command extractors (plan E). A media-generation submit returns the run
// handle as `output.data.id`; a research collect/scrape launch returns it as a
// top-level `runHandle`. Both may also come back already terminal (small/sync
// jobs), in which case there is nothing to resume and we stay silent.
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'succeeded',
  'success',
  'failed',
  'error',
  'expired',
  'canceled',
  'cancelled',
]);

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status.toLowerCase());
}

// Shell-escape an argument value for a copy-pasteable command snippet: wrap in
// single quotes and escape any embedded single quote, so spaces or shell
// metacharacters in a run id can't break or unsafely alter a pasted command.
export function shellQuoteArg(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

// Shared bounded wait loop for every resumable hosted run (`media poll
// --handle`, `research collect/scrape --run-handle`). One invocation re-checks
// the read-only status boundary until the run is terminal, the payload stops
// exposing a readable status (fail safe: return it rather than loop blind), or
// the wait budget is spent — then returns the latest payload as-is. Every check
// is an independent short HTTP read; nothing holds a connection open.
export async function pollHostedRunUntilSettled(input: {
  pollIntervalMs: number;
  pollOnce: (timeoutMs?: number) => Promise<unknown>;
  readStatus: (payload: unknown) => string | null;
  waitBudgetMs: number;
  retryTransientErrors?: boolean;
}): Promise<unknown> {
  const startedAt = performance.now();
  let consecutiveErrors = 0;
  let latestPending: unknown;
  let hasPending = false;
  while (true) {
    let payload: unknown;
    try {
      const remaining = input.waitBudgetMs - (performance.now() - startedAt);
      if (input.retryTransientErrors && hasPending && remaining <= 0)
        return latestPending;
      payload = await input.pollOnce(
        input.retryTransientErrors
          ? Math.min(
              30000,
              input.waitBudgetMs === 0
                ? 30000
                : Math.max(1, Math.ceil(remaining)),
            )
          : undefined,
      );
      consecutiveErrors = 0;
    } catch (error) {
      const remaining = input.waitBudgetMs - (performance.now() - startedAt);
      // Spending the local wait budget does not fail the durable task. Return
      // only a previously observed pending result, never invent a terminal one.
      if (
        input.retryTransientErrors &&
        hasPending &&
        remaining <= 0 &&
        isRetryableHostedStatusError(error)
      )
        return latestPending;
      if (
        !input.retryTransientErrors ||
        !isRetryableHostedStatusError(error) ||
        consecutiveErrors >= 3 ||
        remaining <= 0
      )
        throw error;
      const delay = Math.max(
        Math.min(input.pollIntervalMs, 1000) * 2 ** consecutiveErrors,
        error instanceof HostedProductRequestError ? error.retryAfterMs : 0,
      );
      // Do not sleep to a deadline that cannot admit another status read.
      if (delay >= remaining) throw error;
      await sleepMs(delay);
      if (performance.now() - startedAt >= input.waitBudgetMs) throw error;
      consecutiveErrors++;
      continue;
    }
    const status = input.readStatus(payload);
    if (!status || isTerminalRunStatus(status)) {
      return payload;
    }
    latestPending = payload;
    hasPending = true;
    const remainingMs = input.waitBudgetMs - (performance.now() - startedAt);
    if (remainingMs <= 0) {
      return payload;
    }
    await sleepMs(Math.min(input.pollIntervalMs, remainingMs));
    if (
      input.retryTransientErrors &&
      performance.now() - startedAt >= input.waitBudgetMs
    )
      return payload;
  }
}

function isRetryableHostedStatusError(error: unknown): boolean {
  if (error instanceof HostedProductRequestError) {
    return (
      error.productError.retryable !== false &&
      [429, 500, 502, 503, 504].includes(error.httpStatus ?? 0)
    );
  }
  // Redirect/proxy policy errors have no transport cause and must fail fast.
  if (!(error instanceof PostPlusNetworkRequestError)) {
    return error instanceof Error && error.name === 'TimeoutError';
  }
  const cause = error.cause;
  if (!(cause instanceof Error)) return false;
  const nested = cause.cause instanceof Error ? cause.cause : cause;
  const code = 'code' in nested ? nested.code : null;
  if (typeof code === 'string') {
    return [
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ].includes(code);
  }
  return (
    cause instanceof TypeError ||
    cause.name === 'TimeoutError' ||
    cause.name === 'AbortError'
  );
}

async function writeQuoteConfirmationChallenge(
  error: HostedQuoteConfirmationRequiredError,
  input: { errorInputLabel: string; outputPath: string | null },
): Promise<string> {
  const challengePath = path.resolve(
    input.outputPath
      ? `${input.outputPath}.quote-confirmation.json`
      : `${input.errorInputLabel}.quote-confirmation.json`,
  );
  await mkdir(path.dirname(challengePath), { recursive: true });
  await writeFile(
    challengePath,
    `${JSON.stringify(error.challenge, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );

  return challengePath;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('PostPlus Cloud returned invalid JSON.');
  }
}

export function readHostedProductError(payload: unknown): HostedProductError {
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  const userAction = typeof record.userAction === 'string'
    ? record.userAction
    : readHostedProductErrorUserAction(record.userAction);

  return {
    message:
      normalizeString(record.error) ??
      normalizeString(record.message) ??
      'PostPlus hosted capability request failed.',
    code:
      normalizeString(record.code) ?? normalizeString(record.productErrorCode),
    ...(record.analysisSubmissionRejected === true
      ? { analysisSubmissionRejected: true as const }
      : {}),
    ...(record.sourceSubmissionRejected === true
      ? { sourceSubmissionRejected: true as const }
      : {}),
    layer: normalizeString(record.layer),
    operationId: normalizeString(record.operationId),
    userMessageRule: normalizeString(record.userMessageRule),
    ...(typeof record.stage === 'string' ? { stage: record.stage } : {}),
    ...(typeof record.retryable === 'boolean'
      ? { retryable: record.retryable }
      : {}),
    ...(userAction ? { userAction } : {}),
  };
}

function readHostedProductErrorUserAction(
  value: unknown,
): HostedProductErrorUserAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const label = normalizeString(record.label);
  const type = normalizeString(record.type);
  const url = normalizeString(record.url);
  if (!label || type !== 'open_url' || !url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
  } catch {
    return null;
  }

  return { label, type: 'open_url', url };
}

// Terminal message that keeps the stable code, owning layer, and operation id
// visible next to the human-readable message so a failed run is locatable.
function formatHostedProductErrorMessage(
  productError: HostedProductError,
): string {
  const locator = [
    productError.code ? `code=${productError.code}` : null,
    productError.layer ? `layer=${productError.layer}` : null,
    productError.operationId ? `operationId=${productError.operationId}` : null,
    productError.runId ? `runId=${productError.runId}` : null,
    productError.stage ? `stage=${productError.stage}` : null,
    productError.retryable === undefined
      ? null
      : `retryable=${productError.retryable}`,
  ].filter((part): part is string => part !== null);

  const message =
    locator.length > 0
      ? `${productError.message} (${locator.join(' ')})`
      : productError.message;
  const action = productError.userAction;
  return action
    ? `${message}\n${typeof action === 'string' ? action : `${action.label}: ${action.url}`}`
    : message;
}

export async function writeResult(
  payload: unknown,
  outputPath: string | null,
  forceStdout: boolean,
  preserveText = false,
): Promise<void> {
  const text =
    typeof payload === 'string' && !forceStdout
      ? preserveText
        ? payload
        : `${payload.replace(/\n*$/u, '')}\n`
      : `${JSON.stringify(payload, null, 2)}\n`;
  if (!outputPath || forceStdout) {
    process.stdout.write(text);
  }
  if (outputPath) {
    const absoluteOutput = path.resolve(outputPath);
    const outputDirectory = path.dirname(absoluteOutput);
    const temporaryOutput = path.join(
      outputDirectory,
      `.${path.basename(absoluteOutput)}.postplus-result-${randomUUID()}.tmp`,
    );
    await mkdir(outputDirectory, { recursive: true });
    try {
      await writeFile(temporaryOutput, text, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryOutput, absoluteOutput);
    } finally {
      await rm(temporaryOutput, { force: true }).catch(() => {});
    }
  }
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

type MediaRunResult = {
  bytes: number | null;
  elapsedMs: number | null;
  error: Record<string, unknown> | null;
  id: string | null;
  markdown: string | null;
  stage: string | null;
  status: string | null;
  totalBytes: number | null;
};

export function readMediaRunResult(payload: unknown): MediaRunResult {
  const none: MediaRunResult = {
    bytes: null,
    elapsedMs: null,
    error: null,
    id: null,
    markdown: null,
    stage: null,
    status: null,
    totalBytes: null,
  };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return none;
  }
  const output = (payload as Record<string, unknown>).output;
  if (!output || typeof output !== 'object' || Array.isArray(output))
    return none;
  const data = (output as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return none;
  const record = data as Record<string, unknown>;
  const progress =
    record.progress &&
    typeof record.progress === 'object' &&
    !Array.isArray(record.progress)
      ? (record.progress as Record<string, unknown>)
      : {};
  return {
    bytes: typeof progress.bytes === 'number' ? progress.bytes : null,
    elapsedMs: typeof record.elapsedMs === 'number' ? record.elapsedMs : null,
    error:
      record.error &&
      typeof record.error === 'object' &&
      !Array.isArray(record.error)
        ? (record.error as Record<string, unknown>)
        : null,
    id: typeof record.id === 'string' && record.id.trim() ? record.id : null,
    markdown:
      typeof record.markdown === 'string' && record.markdown.trim()
        ? record.markdown
        : null,
    stage:
      typeof record.stage === 'string' && record.stage.trim()
        ? record.stage
        : null,
    status:
      typeof record.status === 'string' && record.status.trim()
        ? record.status
        : null,
    totalBytes:
      typeof progress.totalBytes === 'number' ? progress.totalBytes : null,
  };
}

export function assertSuccessfulMediaTerminal(payload: unknown) {
  const run = readMediaRunResult(payload);
  const status = run.status?.toLowerCase();
  if (
    !status ||
    !['failed', 'error', 'expired', 'canceled', 'cancelled'].includes(status)
  )
    return payload;
  const code =
    typeof run.error?.code === 'string'
      ? run.error.code
      : 'postplus_cli_hosted_media_run_failed';
  const stage = run.stage ?? 'unknown';
  const userAction =
    typeof run.error?.userAction === 'string'
      ? run.error.userAction
      : (readHostedProductErrorUserAction(run.error?.userAction) ??
        'Query the same run or contact PostPlus support with its operation id; do not resubmit.');
  const retryable = run.error?.retryable === true;
  const productError: HostedProductError = {
    ...readHostedProductError(payload),
    message: `The media task ended with status ${status}.`,
    code,
    stage,
    userAction,
    retryable,
    ...(run.id ? { runId: run.id } : {}),
  };

  throw new HostedProductRequestError(productError);
}

// Read the `{ id, status }` run projection out of a media-generation payload
// (`output.data`). Shared by the submit resume hint and the poll wait loop; a
// payload without the projection yields nulls so callers fail safe (no resume
// hint, no blind wait loop).
export function readMediaPollRun(payload: unknown): {
  id: string | null;
  status: string | null;
} {
  const none = { id: null, status: null };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return none;
  }
  const output = (payload as Record<string, unknown>).output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return none;
  }
  const data = (output as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return none;
  }
  const record = data as Record<string, unknown>;
  return {
    id: typeof record.id === 'string' && record.id.trim() ? record.id : null,
    status:
      typeof record.status === 'string' && record.status.trim()
        ? record.status
        : null,
  };
}

export function readHostedUploadOutput(
  payload: unknown,
): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const output = (payload as Record<string, unknown>).output;
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      return output as Record<string, unknown>;
    }
  }
  throw new Error('Hosted media upload response is missing output.');
}
