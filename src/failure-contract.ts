/** One failure fact for machine diagnostics and the short interactive message. */
export type FailureFact = {
  code: string;
  stage: string;
  service: string;
  correlationId: string | null;
  retryable: boolean;
  message: string;
  action: string;
  cause: { name: string; code: string | null; message: string }[];
  failureStage?: string;
  currentVersion?: string;
  targetVersion?: string;
  component?: string;
  operation?: string;
  version?: string;
  platform?: string;
  originalUrl?: string;
  failureUrl?: string;
  elapsedMs?: number;
  timeoutMs?: number;
  targetHost?: string;
  method?: string;
  httpStatus?: number;
  operationId?: string;
  sourceOperationId?: string;
  runId?: string;
  checkpointId?: string;
  resumeAvailable?: boolean;
  compatibilityReason?: string;
  recovery?: { attempted: true; exhausted: true; nextActionAfterUserResolution: string };
  versions?: Record<string, string | null>;
};

export class PostPlusFailure extends Error {
  readonly code: string;
  constructor(
    message: string,
    readonly details: Partial<FailureFact> & { code: string },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PostPlusFailure";
    this.code = details.code;
  }
}

export function sanitizeFailureText(value: string): string {
  return value
    .replace(/\b(?:set-cookie|cookie)\s*:[^\r\n]*/giu, "Cookie: [redacted]")
    .replace(
      /(?:https?:\/\/|postplus-media:\/\/)[^\s"'<>]+/giu,
      "[redacted-url]",
    )
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [redacted]")
    .replace(
      /((?:authorization|cookie|password|passwd|credential|secret|signature|token|api[_-]?key)[\w-]*["']?\s*[:=]\s*["']?)[^\s,"';}]+/giu,
      "$1[redacted]",
    )
    .replace(/(?:file:\/\/)?\/(?:Users|home|root|private|tmp|var|Volumes)\/[^\r\n"'<>;,)}]+/gu, "[redacted-path]")
    .replace(/[A-Za-z]:[\\/][^\r\n"'<>;,)}]+/gu, "[redacted-path]")
    .replace(/[\r\n]+/gu, " ")
    .slice(0, 8_192);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '[redacted-url]';
    return `${url.protocol}//${url.host}${sanitizeFailureText(url.pathname)}${url.search ? '?[redacted]' : ''}`;
  } catch { return '[redacted-url]'; }
}

/** A child report is untrusted input; project only failure-contract fields. */
export function readFailureOutput(stdout: string): FailureFact | undefined {
  try {
    const report = record(JSON.parse(stdout));
    const error = record(report.error);
    if (report.ok !== false || !['code', 'stage', 'service', 'message', 'action'].every(key => typeof error[key] === 'string') ||
        typeof error.retryable !== 'boolean' || !Array.isArray(error.cause)) return undefined;
    return toFailureFact(Object.assign(new Error(String(error.message)), error));
  } catch { return undefined; }
}

export function toFailureFact(
  error: unknown,
  context: { stage?: string; service?: string; helpCommand?: string } = {},
): FailureFact {
  // Operation evidence can cross a command/installation wrapper, while that
  // wrapper retains ownership of its public error code and next action.
  const inherited: Record<string, unknown> = {};
  const traversed = new Set<unknown>();
  let ancestor: unknown = error;
  while (ancestor && !traversed.has(ancestor) && traversed.size < 6) {
    traversed.add(ancestor);
    const item = record(ancestor);
    if (ancestor !== error && inherited.failureStage === undefined && string(item.stage)) inherited.failureStage = item.stage;
    for (const key of ['failureStage', 'currentVersion', 'targetVersion', 'component', 'operation', 'version', 'platform', 'originalUrl', 'failureUrl', 'elapsedMs', 'timeoutMs', 'httpStatus', 'targetHost', 'method', 'correlationId']) {
      if (inherited[key] === undefined && item[key] !== undefined) inherited[key] = item[key];
    }
    ancestor = item.failure ?? item.cause;
  }
  const source: Record<string, unknown> = {
    ...inherited,
    ...record(error),
    code: record(error).code,
    ...(error instanceof PostPlusFailure ? error.details : {}),
  };
  const originalMessage =
    error instanceof Error ? error.message : string(source.message);
  const invalidArguments =
    /^(?:Unknown (?:option|command|media endpoint|research route|media verb|[a-z-]+ target)|Missing (?:value for|required option)|Unexpected positional argument|--[a-z][a-z0-9-]* (?:must|requires)|(?:postplus )?(?:auth|quote|runs|skills|media|research|studio)[^\n]* requires)/u.test(
      originalMessage ?? "",
    );
  const code =
    string(source.code) ??
    (invalidArguments ? "postplus_invalid_arguments" : "postplus_cli_failed");
  const transport = code === "postplus_cli_cloud_transport_failed";
  const upgrade = code === "postplus_client_upgrade_required";
  const releasing = code === "postplus_cli_cloud_release_in_progress";
  const mediaTransfer =
    typeof source.checkpointId === "string" &&
    typeof source.userAction === "string";
  const cause: FailureFact["cause"] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    current !== undefined &&
    current !== null &&
    !seen.has(current) &&
    cause.length < 4
  ) {
    seen.add(current);
    if (Array.isArray(current)) {
      const entries = current.filter((entry, index) => index !== 0 || !cause.some(prior => prior.code === record(entry).code && prior.message === record(entry).message));
      for (const entry of entries.slice(0, 4 - cause.length)) {
        const item = record(entry);
        cause.push({ name: sanitizeFailureText(string(item.name) ?? 'Error'),
          code: typeof item.code === 'string' || typeof item.code === 'number' ? sanitizeFailureText(String(item.code)) : null,
          message: sanitizeFailureText(string(item.message) ?? 'Unknown child failure.') });
      }
      break;
    }
    const item = record(current);
    cause.push({
      name: sanitizeFailureText(string(item.name) ?? "Error"),
      code: typeof item.code === 'string' || typeof item.code === 'number' ? sanitizeFailureText(String(item.code)) : null,
      message: sanitizeFailureText(string(item.message) ?? String(current)),
    });
    current = item.failure ?? item.cause;
  }
  return {
    code: sanitizeFailureText(code),
    stage: sanitizeFailureText(string(source.stage) ?? context.stage ?? "command"),
    service: sanitizeFailureText(string(source.service) ?? context.service ?? (transport ? "network" : "cli")),
    correlationId: string(source.correlationId) ? sanitizeFailureText(String(source.correlationId)) : null,
    ...(string(source.operationId) ? { operationId: sanitizeFailureText(String(source.operationId)) } : {}),
    retryable:
      typeof source.retryable === "boolean"
        ? source.retryable
        : transport || releasing,
    message: sanitizeFailureText(
      invalidArguments
        ? originalMessage!.split("\n")[0]!
        : mediaTransfer
          ? `PostPlus media transfer stopped (${code}).`
          : transport
            ? "PostPlus could not reach the requested service."
            : upgrade
              ? (string(source.summary) ?? "Your PostPlus installation needs an update.")
              : releasing
                ? "PostPlus Cloud is updating."
                : (string(source.message) ??
                  (error instanceof Error
                    ? error.message
                    : "PostPlus could not complete the command.")),
    ),
    action: sanitizeFailureText(
      string(source.action) ??
        string(source.userAction) ??
        (invalidArguments
          ? `Run ${context.helpCommand ?? `postplus ${context.stage ?? ""}`.trim()} --help.`
          : upgrade
            ? "Run postplus update."
            : releasing
              ? "Retry in about one minute."
              : transport
                ? "Check network and proxy settings; use the task’s recovery instructions if work has already started."
                : "Resolve the reported problem, then retry the command."),
    ),
    cause,
    ...Object.fromEntries(['failureStage', 'currentVersion', 'targetVersion', 'component', 'operation', 'version', 'platform', 'operationId', 'sourceOperationId', 'runId'].flatMap(key =>
      string(source[key]) ? [[key, sanitizeFailureText(String(source[key]))]] : [])),
    ...(source.originalUrl ? { originalUrl: safeUrl(source.originalUrl) } : {}),
    ...(source.failureUrl ? { failureUrl: safeUrl(source.failureUrl) } : {}),
    ...Object.fromEntries(['elapsedMs', 'timeoutMs'].flatMap(key =>
      typeof source[key] === 'number' && Number.isFinite(source[key]) && source[key] >= 0 ? [[key, source[key]]] : [])),
    ...(record(source.recovery).exhausted === true ? { recovery: { attempted: true as const, exhausted: true as const, nextActionAfterUserResolution: sanitizeFailureText(string(record(source.recovery).nextActionAfterUserResolution) ?? '') } } : {}),
    ...(string(source.compatibilityReason) ? { compatibilityReason: sanitizeFailureText(String(source.compatibilityReason)) } : {}),
    ...(source.versions && typeof source.versions === 'object' ? { versions: Object.fromEntries(
      Object.entries(source.versions).filter(([key]) => ['cliVersion', 'skillsReleaseId', 'requiredCliVersion', 'requiredSkillsReleaseId'].includes(key))
        .map(([key, value]) => [key, typeof value === 'string' ? sanitizeFailureText(value) : null])
    ) } : {}),
    ...(string(source.targetHost)
      ? { targetHost: sanitizeFailureText(String(source.targetHost)) }
      : {}),
    ...(string(source.method) ? { method: sanitizeFailureText(String(source.method)) } : {}),
    ...(typeof source.httpStatus === "number"
      ? { httpStatus: source.httpStatus }
      : {}),
    ...(string(source.checkpointId)
      ? { checkpointId: sanitizeFailureText(String(source.checkpointId)) }
      : {}),
    ...(typeof source.resumeAvailable === "boolean"
      ? { resumeAvailable: source.resumeAvailable }
      : {}),
  };
}

export function formatFailure(fact: FailureFact): string {
  const evidence = fact.component ? [
    `component=${fact.component}`, `stage=${fact.stage}`, `operation=${fact.operation ?? 'unknown'}`,
    ...(fact.failureStage ? [`failureStage=${fact.failureStage}`] : []),
    `currentVersion=${fact.currentVersion ?? 'unknown'}`, `targetVersion=${fact.targetVersion ?? fact.version ?? 'unknown'}`,
    ...(fact.version ? [`version=${fact.version}`] : []),
    ...(fact.platform ? [`platform=${fact.platform}`] : []),
    ...(fact.originalUrl ? [`originalUrl=${fact.originalUrl}`] : []),
    ...(fact.failureUrl ? [`failureUrl=${fact.failureUrl}`] : []),
    ...(fact.httpStatus !== undefined ? [`httpStatus=${fact.httpStatus}`] : []),
    ...(fact.elapsedMs !== undefined ? [`elapsedMs=${fact.elapsedMs}`] : []),
    ...(fact.timeoutMs !== undefined ? [`timeoutMs=${fact.timeoutMs}`] : []),
    `code=${fact.code}`,
    ...fact.cause.map(cause => `${cause.name}${cause.code ? ` code=${cause.code}` : ''}: ${cause.message}`),
  ].join('; ') : [
    `code=${fact.code}`, `stage=${fact.stage}`, `service=${fact.service}`,
    ...(fact.method ? [`method=${fact.method}`] : []),
    ...(fact.targetHost ? [`host=${fact.targetHost}`] : []),
    ...(fact.httpStatus !== undefined ? [`httpStatus=${fact.httpStatus}`] : []),
    ...(fact.correlationId ? [`correlationId=${fact.correlationId}`] : []),
    ...(fact.operationId ? [`operationId=${fact.operationId}`] : []),
    ...(fact.sourceOperationId ? [`sourceOperationId=${fact.sourceOperationId}`] : []),
    ...(fact.runId ? [`runId=${fact.runId}`] : []),
    ...(fact.checkpointId ? [`checkpointId=${fact.checkpointId}`] : []),
    `retryable=${fact.retryable}`,
    ...fact.cause.filter(cause => cause.message !== fact.message).slice(-2)
      .map(cause => `${cause.name}${cause.code ? ` code=${cause.code}` : ''}: ${cause.message.slice(0, 400)}`),
  ].join('; ');
  return `${fact.message}${evidence ? `\nDiagnostics: ${evidence}` : ''}\nNext: ${fact.action}`;
}

export function stopAutomaticRecovery(fact: FailureFact): FailureFact {
  return { ...fact, retryable: false,
    action: 'Stop automatic recovery and report this failure; do not run another update or resubmit the task.',
    recovery: { attempted: true, exhausted: true,
      nextActionAfterUserResolution: fact.recovery?.nextActionAfterUserResolution ?? fact.action } };
}

export function writeFailure(
  error: unknown,
  options: { json: boolean; stage?: string; service?: string; helpCommand?: string; automaticRecovery?: boolean },
): void {
  const fact = toFailureFact(error, options);
  const failure = options.automaticRecovery ? stopAutomaticRecovery(fact) : fact;
  if (options.json)
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: failure }, null, 2)}\n`,
    );
  else process.stderr.write(`${formatFailure(failure)}\n`);
}

/** Correlation is evidence from the service response, never a locally invented ID. */
export function withResponseMetadata<T extends Error>(
  error: T,
  response: Response,
): T {
  const correlationId =
    response.headers.get("x-correlation-id") ??
    response.headers.get("x-request-id") ??
    string(record(error).correlationId);
  Object.assign(error, {
    correlationId: correlationId ? sanitizeFailureText(correlationId) : null,
    httpStatus: response.status,
  });
  return error;
}

/** Project a public response through the existing whitelist; never attach raw payloads. */
export function responseFailure(
  payload: unknown,
  response: Response,
  context: { stage: string; service?: string; message?: string; messageOverride?: string },
): Error {
  const outer = record(payload);
  const nested = record(outer.error);
  const source = { ...outer, ...nested };
  const message = context.messageOverride ?? string(nested.message) ?? string(nested.error) ?? string(outer.error) ??
    string(outer.message) ?? (typeof payload === 'string' ? payload : undefined) ??
    context.message ?? 'PostPlus Cloud request failed (no recognized error details).';
  const fact = toFailureFact({ ...source, message }, { ...context, service: context.service ?? 'postplus-cloud' });
  const error = Object.assign(new Error(fact.message), fact);
  return withResponseMetadata(error, response);
}

/** Do not expose invalid response bodies or JSON parser excerpts. */
export async function readCloudJsonResponse(response: Response, stage: string): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw withResponseMetadata(new PostPlusFailure('PostPlus Cloud response body was interrupted.', {
      code: 'postplus_cli_cloud_transport_failed', stage, service: 'postplus-cloud',
      action: 'Check the connection; resume the original task if work has already started.',
    }, { cause }), response);
  }
  if (!text.trim()) return null;
  try { return JSON.parse(text) as unknown; }
  catch {
    throw withResponseMetadata(new PostPlusFailure('PostPlus Cloud returned invalid JSON.', {
      code: 'postplus_cli_invalid_response', stage, service: 'postplus-cloud', retryable: false,
      action: 'Report the HTTP status and correlation ID; keep any existing task checkpoint.',
    }), response);
  }
}
