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
  targetHost?: string;
  method?: string;
  httpStatus?: number;
  checkpointId?: string;
  resumeAvailable?: boolean;
  compatibilityReason?: string;
  contentState?: 'modified' | 'unverified';
  conflicts?: { name: string; path: string; state: 'modified' | 'unverified' }[];
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

export function toFailureFact(
  error: unknown,
  context: { stage?: string; service?: string; helpCommand?: string } = {},
): FailureFact {
  const source: Record<string, unknown> = {
    ...record(error),
    ...(error instanceof PostPlusFailure ? error.details : {}),
  };
  const originalMessage =
    error instanceof Error ? error.message : string(source.message);
  const invalidArguments =
    /^(?:Unknown (?:option|command|media endpoint|research route|media verb|[a-z-]+ target)|Missing (?:value for|required option)|Unexpected positional argument|--[a-z][a-z0-9-]* (?:must|requires)|(?:postplus )?(?:auth|quote|runs|skills|media|research|publish|studio)[^\n]* requires)/u.test(
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
    const item = record(current);
    cause.push({
      name: sanitizeFailureText(string(item.name) ?? "Error"),
      code: string(item.code) ? sanitizeFailureText(String(item.code)) : null,
      message: sanitizeFailureText(string(item.message) ?? String(current)),
    });
    current = item.cause;
  }
  return {
    code,
    stage: string(source.stage) ?? context.stage ?? "command",
    service:
      string(source.service) ??
      context.service ??
      (transport ? "network" : "cli"),
    correlationId: string(source.correlationId) ?? null,
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
    ...(['modified', 'unverified'].includes(String(source.contentState)) ? {
      contentState: source.contentState as 'modified' | 'unverified',
      conflicts: Array.isArray(source.conflicts) ? source.conflicts.flatMap((item) => {
        const conflict = record(item);
        return typeof conflict.name === 'string' && typeof conflict.path === 'string' &&
          (conflict.state === 'modified' || conflict.state === 'unverified')
          ? [{ name: sanitizeFailureText(conflict.name), path: sanitizeFailureText(conflict.path), state: conflict.state }] : [];
      }) : [],
    } : {}),
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
  return `${fact.message}\nNext: ${fact.action}`;
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
    response.headers.get("x-request-id");
  Object.assign(error, {
    correlationId: correlationId ? sanitizeFailureText(correlationId) : null,
    httpStatus: response.status,
  });
  return error;
}
