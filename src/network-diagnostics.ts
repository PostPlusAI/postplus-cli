const MAX_DEBUG_BODY_CHARS = 2_048;
const MAX_ERROR_CAUSES = 4;
const DEFAULT_MAX_REDIRECTS = 5;

type RedirectPolicy = 'error' | 'follow-https';

export type NetworkRequestOptions = {
  debug?: boolean;
  label: string;
  maxRedirects?: number;
  redirectPolicy: RedirectPolicy;
};

export class PostPlusNetworkRequestError extends Error {
  readonly code = 'postplus_cli_cloud_transport_failed';
  readonly method: string;
  readonly targetHost: string;

  constructor(input: {
    cause?: unknown;
    detail?: string;
    method: string;
    targetUrl: string;
  }) {
    const targetHost = readTargetHost(input.targetUrl);
    const detail =
      input.detail ?? formatNetworkErrorChain(input.cause ?? 'unknown error');
    super(
      `PostPlus network request failed (code=postplus_cli_cloud_transport_failed, method=${input.method}, host=${targetHost}): ${detail}`,
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.name = 'PostPlusNetworkRequestError';
    this.method = input.method;
    this.targetHost = targetHost;
  }
}

export async function fetchWithNetworkDiagnostics(
  inputUrl: string | URL,
  init: RequestInit,
  options: NetworkRequestOptions,
): Promise<Response> {
  let currentUrl = new URL(inputUrl);
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  for (let redirectCount = 0; ; redirectCount += 1) {
    writeDebug(
      options,
      `request method=${method} target=${formatDebugUrl(currentUrl, options)}`,
    );

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        ...init,
        body,
        headers,
        method,
        redirect: 'manual',
      });
    } catch (error) {
      const wrapped = new PostPlusNetworkRequestError({
        cause: error,
        method,
        targetUrl: currentUrl.toString(),
      });
      writeDebug(options, `error ${wrapped.message}`);
      throw wrapped;
    }

    writeDebug(
      options,
      `response status=${response.status}${response.statusText ? ` ${response.statusText}` : ''} target=${formatDebugUrl(currentUrl, options)}`,
    );

    if (!isRedirectStatus(response.status)) {
      if (!response.ok) {
        await writeDebugResponseBody(options, response);
      }
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      await response.body?.cancel().catch(() => {});
      throw new PostPlusNetworkRequestError({
        detail: `HTTP ${response.status} redirect is missing Location.`,
        method,
        targetUrl: currentUrl.toString(),
      });
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      await response.body?.cancel().catch(() => {});
      throw new PostPlusNetworkRequestError({
        detail: `HTTP ${response.status} redirect has invalid Location.`,
        method,
        targetUrl: currentUrl.toString(),
      });
    }
    writeDebug(
      options,
      `redirect status=${response.status} from=${formatDebugUrl(currentUrl, options)} to=${formatDebugUrl(nextUrl, options)}`,
    );
    await response.body?.cancel().catch(() => {});

    if (options.redirectPolicy === 'error') {
      throw new PostPlusNetworkRequestError({
        detail: `Unexpected HTTP ${response.status} redirect.`,
        method,
        targetUrl: currentUrl.toString(),
      });
    }
    if (nextUrl.protocol !== 'https:') {
      throw new PostPlusNetworkRequestError({
        detail: `Refused media redirect to non-HTTPS host=${nextUrl.host}.`,
        method,
        targetUrl: currentUrl.toString(),
      });
    }
    if (redirectCount >= maxRedirects) {
      throw new PostPlusNetworkRequestError({
        detail: `Redirect limit exceeded (${maxRedirects}).`,
        method,
        targetUrl: currentUrl.toString(),
      });
    }

    if (shouldRewriteRedirectToGet(response.status, method)) {
      method = 'GET';
      body = undefined;
      delete headers['content-length'];
      delete headers['content-type'];
    }
    currentUrl = nextUrl;
  }
}

export function isNetworkFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const name = readErrorField(current, 'name');
    const message = readErrorField(current, 'message');
    const code = readErrorField(current, 'code');

    if (
      code === 'postplus_cli_cloud_transport_failed' ||
      name === 'AbortError' ||
      name === 'TimeoutError' ||
      /fetch failed|terminated/iu.test(message ?? '') ||
      /^(?:EAI_AGAIN|ECONN|ENET|ENOTFOUND|ETIMEDOUT|UND_ERR_|ERR_TLS|CERT_)/u.test(
        code ?? '',
      )
    ) {
      return true;
    }

    current = 'cause' in current ? current.cause : null;
  }

  return false;
}

export function formatNetworkErrorChain(error: unknown): string {
  const summaries: string[] = [];
  const seen = new Set<object>();
  let current: unknown = error;

  while (
    current !== null &&
    current !== undefined &&
    summaries.length < MAX_ERROR_CAUSES
  ) {
    if (typeof current === 'object') {
      if (seen.has(current)) {
        break;
      }
      seen.add(current);
    }

    summaries.push(formatNetworkError(current));
    current =
      current && typeof current === 'object' && 'cause' in current
        ? current.cause
        : null;
  }

  return summaries.join(' <- caused by ');
}

export function readTargetHost(url: string): string {
  try {
    return new URL(url).host || 'unknown';
  } catch {
    return 'invalid-url';
  }
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function shouldRewriteRedirectToGet(status: number, method: string): boolean {
  return (
    status === 303 || ((status === 301 || status === 302) && method === 'POST')
  );
}

function formatNetworkError(error: unknown): string {
  if (!(error instanceof Error)) {
    return sanitizeDiagnosticText(String(error));
  }

  const metadata = ['code', 'errno', 'syscall', 'hostname']
    .map((field) => {
      const value = readErrorField(error, field);
      return value ? `${field}=${sanitizeDiagnosticText(value)}` : null;
    })
    .filter((value): value is string => value !== null)
    .join(' ');
  const message = sanitizeDiagnosticText(error.message || 'no message');

  return `${error.name || 'Error'}${metadata ? ` ${metadata}` : ''}: ${message}`;
}

function readErrorField(error: object, field: string): string | null {
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : null;
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[redacted-url]')
    .replace(/postplus-media:\/\/[^\s"'<>]+/giu, '[redacted-media-reference]');
}

function formatDebugUrl(url: URL, options: NetworkRequestOptions): string {
  const pathname =
    options.label === 'media-download'
      ? formatMediaDebugPath(url.pathname)
      : url.pathname;
  return `${url.protocol}//${url.host}${pathname}`;
}

function formatMediaDebugPath(pathname: string): string {
  const storageRoute = pathname.match(
    /^(\/storage\/v1\/object\/(?:authenticated|public|sign)\/[^/]+)\//u,
  );
  return storageRoute?.[1]
    ? `${storageRoute[1]}/[redacted-object]`
    : '/[redacted-path]';
}

function writeDebug(options: NetworkRequestOptions, message: string): void {
  if (!options.debug) {
    return;
  }
  process.stderr.write(`[postplus debug] ${options.label} ${message}\n`);
}

async function writeDebugResponseBody(
  options: NetworkRequestOptions,
  response: Response,
): Promise<void> {
  if (!options.debug) {
    return;
  }
  try {
    const text = await response.clone().text();
    const preview = redactResponseBody(text, options).slice(
      0,
      MAX_DEBUG_BODY_CHARS,
    );
    writeDebug(
      options,
      `response-body ${preview || '[empty]'}${text.length > MAX_DEBUG_BODY_CHARS ? ' [truncated]' : ''}`,
    );
  } catch (error) {
    writeDebug(
      options,
      `response-body-unavailable ${formatNetworkErrorChain(error)}`,
    );
  }
}

function redactResponseBody(
  text: string,
  options: NetworkRequestOptions,
): string {
  try {
    return JSON.stringify(
      redactJsonValue(JSON.parse(text) as unknown, options),
    );
  } catch {
    return sanitizeUrlQueries(sanitizeDiagnosticText(text), options);
  }
}

function redactJsonValue(
  value: unknown,
  options: NetworkRequestOptions,
  key = '',
): unknown {
  if (isSensitiveKey(key)) {
    return '[redacted]';
  }
  if (typeof value === 'string') {
    return sanitizeUrlQueries(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, options));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([entryKey, item]) => [
          entryKey,
          redactJsonValue(item, options, entryKey),
        ],
      ),
    );
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /authorization|cookie|credential|secret|signature|token|api[_-]?key/iu.test(
    key,
  );
}

function sanitizeUrlQueries(
  value: string,
  options: NetworkRequestOptions,
): string {
  return value
    .replace(/postplus-media:\/\/[^\s"'<>]+/giu, '[redacted-media-reference]')
    .replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
      try {
        const url = new URL(candidate);
        const pathname =
          options.label === 'media-download'
            ? formatMediaDebugPath(url.pathname)
            : url.pathname;
        return `${url.protocol}//${url.host}${pathname}${url.search ? '?[redacted]' : ''}`;
      } catch {
        return '[redacted-url]';
      }
    });
}
