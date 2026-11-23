import { setTimeout as sleepMs } from 'node:timers/promises';

import { resolveFreshRemoteAuth } from './auth-session.js';
import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import {
  PostPlusClientUpgradeRequiredError,
  formatPostPlusCompatibilityError,
  isPostPlusClientUpgradePayload,
} from './client-compatibility.js';
import { sanitizeFailureText, withResponseMetadata } from './failure-contract.js';
import {
  HostedCompatibilityRequestError,
  HostedProductRequestError,
  type HostedRequestContext,
  isRetryableHostedStatusError,
  readHostedProductError,
} from './hosted-command-runtime.js';
import { isNetworkFailure } from './network-diagnostics.js';
import type { ProxyDispatcherScope } from './proxy-configuration.js';
import { clearUpdateCheckCache } from './update-check.js';

const DEFAULT_SSE_IDLE_TIMEOUT_MS = 25_000;
const MAX_SSE_SERVER_WINDOW_MS = 50_000;
const MAX_SSE_REQUEST_WAIT_MS = 600_000;

export type SseEvent = {
  event: string;
  data: string;
};

export type MetaResearchStreamIdentity =
  | { sourceOperationId: string }
  | { runHandle: string };

export type WaitForMetaResearchViaSseInput = {
  context?: HostedRequestContext;
  dispatcherScope?: ProxyDispatcherScope;
  fallbackPoll: (remainingWaitBudgetMs: number) => Promise<unknown>;
  getIdentity: () => MetaResearchStreamIdentity;
  idleTimeoutMs?: number;
  onPayload: (payload: unknown) => Promise<void>;
  waitBudgetMs: number;
};

class SseStreamTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SseStreamTransportError';
  }
}

export async function* parseSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  options?: { idleTimeoutMs?: number },
): AsyncGenerator<SseEvent> {
  signal?.throwIfAborted();
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const idleTimeoutMs = options?.idleTimeoutMs;

  let buffer = '';
  let eventType = '';
  let dataLines: string[] = [];
  let streamDone = false;

  const abortController = new AbortController();
  const onOuterAbort = () => {
    abortController.abort(signal?.reason);
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) {
      abortController.abort(signal.reason);
      void reader.cancel(signal.reason).catch(() => undefined);
    } else {
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }
  }

  const processLine = (rawLine: string): SseEvent | null => {
    if (rawLine === '') {
      if (dataLines.length === 0) {
        eventType = '';
        return null;
      }
      const event: SseEvent = {
        event: eventType || 'message',
        data: dataLines.join('\n'),
      };
      eventType = '';
      dataLines = [];
      return event;
    }

    if (rawLine.startsWith(':')) {
      return null;
    }

    const colonIndex = rawLine.indexOf(':');
    const field = colonIndex === -1 ? rawLine : rawLine.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : rawLine.slice(colonIndex + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    if (field === 'event') {
      eventType = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    return null;
  };

  const readChunkWithIdleTimeout = async () => {
    if (!idleTimeoutMs || idleTimeoutMs <= 0) {
      return reader.read();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const timeoutError = new DOMException(
              'The operation was aborted due to timeout',
              'TimeoutError',
            );
            abortController.abort(timeoutError);
            void reader.cancel(timeoutError).catch(() => undefined);
            reject(timeoutError);
          }, idleTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  try {
    while (true) {
      abortController.signal.throwIfAborted();
      const { done, value } = await readChunkWithIdleTimeout();
      if (done) {
        streamDone = true;
        buffer += decoder.decode();
      } else if (value) {
        buffer += decoder.decode(value, { stream: true });
      }

      let pos = 0;
      while (pos < buffer.length) {
        const crIndex = buffer.indexOf('\r', pos);
        const lfIndex = buffer.indexOf('\n', pos);
        let lineEnd = -1;
        let nextPos = -1;

        if (crIndex !== -1 && (lfIndex === -1 || crIndex < lfIndex)) {
          if (crIndex + 1 === buffer.length && !done) {
            break;
          }
          lineEnd = crIndex;
          nextPos = buffer[crIndex + 1] === '\n' ? crIndex + 2 : crIndex + 1;
        } else if (lfIndex !== -1) {
          lineEnd = lfIndex;
          nextPos = lfIndex + 1;
        } else {
          break;
        }

        const line = buffer.slice(pos, lineEnd);
        pos = nextPos;
        const parsed = processLine(line);
        if (parsed) {
          yield parsed;
        }
      }

      buffer = buffer.slice(pos);

      if (done) {
        if (buffer.length > 0) {
          const parsed = processLine(buffer);
          buffer = '';
          if (parsed) {
            yield parsed;
          }
        }
        break;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onOuterAbort);
    if (!streamDone) {
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export async function waitForMetaResearchViaSse(
  input: WaitForMetaResearchViaSseInput,
): Promise<unknown> {
  const startedAt = performance.now();
  const idleTimeoutMs = input.idleTimeoutMs ?? DEFAULT_SSE_IDLE_TIMEOUT_MS;
  let lastObservedPayload: unknown;
  let hasObserved = false;

  while (true) {
    const remainingBudgetMs = input.waitBudgetMs - (performance.now() - startedAt);
    if (remainingBudgetMs <= 0) {
      return hasObserved ? lastObservedPayload : input.fallbackPoll(0);
    }

    const streamWaitMs = Math.max(
      1,
      Math.min(MAX_SSE_REQUEST_WAIT_MS, Math.ceil(remainingBudgetMs)),
    );
    const requestTimeoutMs = Math.min(
      Math.max(30_000, Math.min(streamWaitMs, MAX_SSE_SERVER_WINDOW_MS) + 15_000),
      70_000,
    );
    const authSignal = AbortSignal.timeout(requestTimeoutMs);

    let response: Response;
    try {
      const auth =
        input.context?.auth ??
        (await resolveFreshRemoteAuth({ signal: authSignal }));
      response = await sendAuthedCloudRequest({
        auth,
        accept: 'text/event-stream',
        body: {
          routeKey: 'facebook-ads-library',
          ...input.getIdentity(),
          waitMs: streamWaitMs,
        },
        dispatcherScope: input.dispatcherScope,
        method: 'POST',
        pathName: '/api/postplus-cli/hosted/research/stream',
        ...(input.context
          ? { skillsReleaseId: input.context.skillsReleaseId ?? null }
          : {
              retryOn401: () =>
                resolveFreshRemoteAuth({ forceRefresh: true, signal: authSignal }),
            }),
        skillName: null,
        timeoutMs: requestTimeoutMs,
      });
    } catch (error) {
      if (isRetryableSseError(error)) {
        const remaining = Math.max(
          0,
          input.waitBudgetMs - (performance.now() - startedAt),
        );
        return remaining <= 0 && hasObserved
          ? lastObservedPayload
          : input.fallbackPoll(remaining);
      }
      throw error;
    }

    if (!response.ok) {
      const payload = await readErrorJsonResponse(response);
      if (isPostPlusClientUpgradePayload(payload)) {
        await clearUpdateCheckCache();
        throw withResponseMetadata(
          new PostPlusClientUpgradeRequiredError(payload),
          response,
        );
      }

      const productError = readHostedProductError(payload);
      const compatibilityError = formatPostPlusCompatibilityError(payload);
      if (compatibilityError) {
        await clearUpdateCheckCache();
        throw withResponseMetadata(
          new HostedCompatibilityRequestError(
            compatibilityError,
            productError.code,
          ),
          response,
        );
      }

      const missingStreamRoute =
        response.status === 404 &&
        productError.code !== 'postplus_cli_hosted_async_run_not_found';
      const retryableHttpStatus = [429, 502, 503, 504].includes(
        response.status,
      );

      if (missingStreamRoute || retryableHttpStatus) {
        const remaining = Math.max(
          0,
          input.waitBudgetMs - (performance.now() - startedAt),
        );
        return remaining <= 0 && hasObserved
          ? lastObservedPayload
          : input.fallbackPoll(remaining);
      }

      productError.httpStatus = response.status;
      productError.correlationId =
        sanitizeFailureText(
          response.headers.get('x-correlation-id') ??
            response.headers.get('x-request-id') ??
            productError.correlationId ??
            '',
        ) || null;
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get('retry-after'),
      );
      throw withResponseMetadata(
        new HostedProductRequestError(
          productError,
          response.status,
          retryAfterMs,
        ),
        response,
      );
    }

    const contentType =
      response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!response.body || !contentType.includes('text/event-stream')) {
      void response.body?.cancel().catch(() => undefined);
      const remaining = Math.max(
        0,
        input.waitBudgetMs - (performance.now() - startedAt),
      );
      return remaining <= 0 && hasObserved
        ? lastObservedPayload
        : input.fallbackPoll(remaining);
    }

    let reconnectRetryMs: number | null = null;
    try {
      for await (const event of parseSseEvents(response.body, undefined, {
        idleTimeoutMs,
      })) {
        if (event.event === 'status') {
          const payload = parseSsePayloadJson(event.data);
          await input.onPayload(payload);
          lastObservedPayload = payload;
          hasObserved = true;
          continue;
        }

        if (event.event === 'result') {
          const payload = parseSsePayloadJson(event.data);
          await input.onPayload(payload);
          return payload;
        }

        if (event.event === 'reconnect') {
          const parsed = parseSsePayloadJson(event.data);
          const retryMs =
            parsed &&
            typeof parsed === 'object' &&
            !Array.isArray(parsed) &&
            typeof (parsed as Record<string, unknown>).retryMs === 'number'
              ? Math.max(0, (parsed as Record<string, unknown>).retryMs as number)
              : 0;
          reconnectRetryMs = retryMs;
          break;
        }

        if (event.event === 'error') {
          const parsed = parseSsePayloadJson(event.data);
          const record =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {};
          const status =
            typeof record.status === 'number' ? record.status : undefined;
          const errorBody = 'body' in record ? record.body : record;
          const productError = readHostedProductError(errorBody);
          if (status !== undefined) {
            productError.httpStatus = status;
          }
          productError.correlationId =
            sanitizeFailureText(
              response.headers.get('x-correlation-id') ??
                response.headers.get('x-request-id') ??
                productError.correlationId ??
                '',
            ) || null;
          throw new HostedProductRequestError(productError, status);
        }
      }
    } catch (error) {
      if (isRetryableSseError(error)) {
        const remaining = Math.max(
          0,
          input.waitBudgetMs - (performance.now() - startedAt),
        );
        return remaining <= 0 && hasObserved
          ? lastObservedPayload
          : input.fallbackPoll(remaining);
      }
      throw error;
    }

    if (reconnectRetryMs === null) {
      // Premature EOF without result or reconnect: fall back cleanly to polling.
      const remaining = Math.max(
        0,
        input.waitBudgetMs - (performance.now() - startedAt),
      );
      return remaining <= 0 && hasObserved
        ? lastObservedPayload
        : input.fallbackPoll(remaining);
    }

    const remainingAfterReconnect =
      input.waitBudgetMs - (performance.now() - startedAt);
    if (remainingAfterReconnect <= 0) {
      return hasObserved ? lastObservedPayload : input.fallbackPoll(0);
    }
    if (reconnectRetryMs > 0) {
      await sleepMs(Math.min(reconnectRetryMs, remainingAfterReconnect));
    }
  }
}

async function readErrorJsonResponse(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text.trim() ? (JSON.parse(text) as unknown) : null;
  } catch {
    return {
      code: 'postplus_cli_hosted_status_unavailable',
      message: `PostPlus request failed with HTTP ${response.status}.`,
    };
  }
}

function parseSsePayloadJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch (error) {
    throw new SseStreamTransportError('Malformed JSON in SSE event data.', {
      cause: error,
    });
  }
}

function isRetryableSseError(error: unknown): boolean {
  if (error instanceof SseStreamTransportError) {
    return true;
  }
  if (isRetryableHostedStatusError(error)) {
    return true;
  }
  if (
    error instanceof HostedProductRequestError ||
    error instanceof HostedCompatibilityRequestError ||
    error instanceof PostPlusClientUpgradeRequiredError
  ) {
    return false;
  }
  if (
    error &&
    typeof error === 'object' &&
    'retryable' in error &&
    error.retryable === false
  ) {
    return false;
  }
  return isNetworkFailure(error);
}

function parseRetryAfterMs(retryAfter: string | null): number {
  if (!retryAfter) {
    return 0;
  }
  const value = /^\d+$/.test(retryAfter)
    ? Number(retryAfter) * 1000
    : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
