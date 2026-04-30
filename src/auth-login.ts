import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { requireHostedBaseUrl } from './hosted-release.js';
import { setLocalSession } from './local-state.js';

export const CLI_AUTH_HANDOFF_TIMEOUT_MS = 30 * 60 * 1000;

export type AuthLoginReport = {
  accountId: string;
  apiBaseUrl: string;
  ok: boolean;
  sessionExpiresAt: number | null;
  userEmail: string | null;
  userId: string;
};

type BrowserHandoffPayload =
  | {
      error: string;
      requestId: string;
    }
  | {
      accessToken: string;
      expiresAt: number | null;
      refreshToken: string;
      requestId: string;
      userEmail: string | null;
    };

type ValidatedCliSession = {
  accountId: string;
  sessionExpiresAt: number | null;
  subscriptionStatus: string | null;
  userEmail: string | null;
  userId: string;
};

type SessionWhoAmIErrorPayload = {
  code?: string;
  error?: string;
};

export async function loginWithBrowserHandoff(): Promise<AuthLoginReport> {
  const baseUrl = await requireHostedBaseUrl();
  const handoff = await createCliAuthHandoffServer({
    allowedOrigin: new URL(baseUrl).origin,
  });
  const loginUrl = buildCliLoginUrl({
    baseUrl,
    bridgeUrl: handoff.bridgeUrl,
    requestId: handoff.requestId,
  });

  process.stdout.write(
    [
      'PostPlus CLI login',
      '',
      'Open this URL in your browser to continue:',
      loginUrl,
      '',
      'Waiting for browser sign-in (up to 30 minutes)...',
      '',
    ].join('\n'),
  );

  try {
    const handoffPayload = await handoff.waitForPayload();

    if ('error' in handoffPayload) {
      throw new Error(handoffPayload.error);
    }

    const validated = await validateCliSession({
      accessToken: handoffPayload.accessToken,
      apiBaseUrl: baseUrl,
    });

    await setLocalSession({
      accessToken: handoffPayload.accessToken,
      accountId: validated.accountId,
      apiBaseUrl: baseUrl,
      refreshToken: handoffPayload.refreshToken,
      sessionExpiresAt:
        validated.sessionExpiresAt ?? handoffPayload.expiresAt ?? null,
      userEmail: validated.userEmail,
      userId: validated.userId,
    });

    return {
      accountId: validated.accountId,
      apiBaseUrl: baseUrl,
      ok: true,
      sessionExpiresAt:
        validated.sessionExpiresAt ?? handoffPayload.expiresAt ?? null,
      userEmail: validated.userEmail,
      userId: validated.userId,
    };
  } finally {
    await handoff.close();
  }
}

function buildCliLoginUrl(input: {
  baseUrl: string;
  bridgeUrl: string;
  requestId: string;
}): string {
  const nextPath = `/auth/cli-callback?bridgeUrl=${encodeURIComponent(
    input.bridgeUrl,
  )}&requestId=${encodeURIComponent(input.requestId)}`;

  return `${input.baseUrl}/auth/sign-in?next=${encodeURIComponent(nextPath)}`;
}

export async function validateCliSession(input: {
  accessToken: string;
  apiBaseUrl: string;
}): Promise<ValidatedCliSession> {
  const response = await fetch(
    `${input.apiBaseUrl}/api/postplus-cli/auth/whoami`,
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.accessToken}`,
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  const payload = (await response.json()) as
    | SessionWhoAmIErrorPayload
    | ValidatedCliSession;

  if (!response.ok) {
    throw new Error(
      formatCliSessionAuthError(payload as SessionWhoAmIErrorPayload),
    );
  }

  return payload as ValidatedCliSession;
}

export function formatCliSessionAuthError(
  payload: SessionWhoAmIErrorPayload,
): string {
  if (payload.code === 'postplus_cli_auth_not_initialized') {
    return [
      'PostPlus CLI auth is not initialized on this environment yet.',
      'Finish the PostPlus CLI server registration flow, then run `postplus auth login` again.',
      'Once the environment is ready, the CLI will automatically obtain and store its session.',
    ].join(' ');
  }

  if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
    return payload.error;
  }

  return 'Failed to validate the browser session for PostPlus CLI.';
}

export async function createCliAuthHandoffServer(input: {
  allowedOrigin: string;
}) {
  const requestId = randomUUID();

  return new Promise<{
    bridgeUrl: string;
    close: () => Promise<void>;
    requestId: string;
    waitForPayload: () => Promise<BrowserHandoffPayload>;
  }>((resolve, reject) => {
    let settled = false;
    let cleanupTimer: NodeJS.Timeout | null = null;
    let resolvePayload: ((payload: BrowserHandoffPayload) => void) | null =
      null;
    let rejectPayload: ((error: Error) => void) | null = null;
    const payloadPromise = new Promise<BrowserHandoffPayload>(
      (innerResolve, innerReject) => {
        resolvePayload = innerResolve;
        rejectPayload = innerReject;
      },
    );

    const server = createServer((request, response) => {
      const origin = request.headers.origin ?? null;
      const allowOrigin =
        origin === input.allowedOrigin ? input.allowedOrigin : null;

      if (request.method === 'OPTIONS') {
        if (!allowOrigin) {
          response.writeHead(403);
          response.end();
          return;
        }

        response.writeHead(204, {
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Private-Network': 'true',
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        });
        response.end();
        return;
      }

      if (request.method !== 'POST' || request.url !== '/handoff') {
        response.writeHead(404);
        response.end();
        return;
      }

      if (!allowOrigin) {
        response.writeHead(403);
        response.end();
        return;
      }

      const chunks: Buffer[] = [];

      request.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on('end', () => {
        try {
          const payload = JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          ) as BrowserHandoffPayload;

          if (payload.requestId !== requestId) {
            throw new Error('Mismatched CLI auth handoff request id.');
          }

          response.writeHead(200, {
            'Access-Control-Allow-Origin': allowOrigin,
            'Content-Type': 'application/json',
            Vary: 'Origin',
          });
          response.end(JSON.stringify({ ok: true }));

          if (!settled) {
            settled = true;
            resolvePayload?.(payload);
          }
        } catch (error) {
          response.writeHead(400, {
            'Access-Control-Allow-Origin': allowOrigin,
            'Content-Type': 'application/json',
            Vary: 'Origin',
          });
          response.end(
            JSON.stringify({
              error:
                error instanceof Error
                  ? error.message
                  : 'Invalid CLI auth handoff payload.',
            }),
          );
        }
      });
    });

    server.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        rejectPayload?.(error as Error);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        const error = new Error('Failed to bind the local CLI auth bridge.');
        if (!settled) {
          settled = true;
          reject(error);
        }
        return;
      }

      cleanupTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectPayload?.(
            new Error('Timed out waiting for the browser sign-in handoff.'),
          );
        }
        server.close();
      }, CLI_AUTH_HANDOFF_TIMEOUT_MS);

      resolve({
        bridgeUrl: `http://127.0.0.1:${(address as AddressInfo).port}/handoff`,
        close: async () =>
          new Promise<void>((innerResolve, innerReject) => {
            if (cleanupTimer) {
              clearTimeout(cleanupTimer);
            }

            server.close((error) => {
              if (error) {
                innerReject(error);
                return;
              }

              innerResolve();
            });
          }),
        requestId,
        waitForPayload: () => payloadPromise,
      });
    });
  });
}
