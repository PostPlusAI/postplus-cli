import { spawn } from 'node:child_process';

import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import {
  buildPostPlusClientCompatibilityHeaders,
  formatPostPlusCompatibilityError,
  readCurrentCliVersion,
  readPostPlusCompatibilityError,
} from './client-compatibility.js';
import { requireHostedBaseUrl } from './hosted-release.js';
import {
  assertLocalConfigWritable,
  resolveApiBaseUrlState,
  setLocalSession,
} from './local-state.js';

// Fallback TOTAL POLLING BUDGET for the browser-login handoff loop — how long
// `waitForCloudAuthLogin` keeps polling when the server's `expiresAt` cannot be
// parsed. It is NOT a per-request timeout (each poll POST carries the 15s
// authed-request default); the old *_TIMEOUT_MS name misread as one
// (2026-07-13 timeout audit rename).
export const CLI_AUTH_LOGIN_POLL_BUDGET_MS = 30 * 60 * 1000;
export const CLI_AUTH_BROWSER_OPEN_TIMEOUT_MS = 5_000;

export type AuthLoginReport = {
  accountId: string;
  accountName: string;
  accountSlug: string | null;
  accountType: 'personal' | 'team';
  apiBaseUrl: string;
  ok: boolean;
  userEmail: string | null;
  userId: string;
};

type CliAuthLoginStartPayload =
  | {
      error?: string;
    }
  | {
      expiresAt: string;
      pollIntervalSeconds: number;
      pollSecret: string;
      requestId: string;
      userCode: string;
      verificationUrl: string;
    };

type CliAuthLoginPollPayload =
  | {
      error?: string;
    }
  | {
      accountId: string;
      accountName: string;
      accountSlug: string | null;
      accountType: 'personal' | 'team';
      cliSessionToken: string;
      sessionExpiresAt: number | null;
      status: 'completed';
      subscriptionStatus: string | null;
      userEmail: string | null;
      userId: string;
    }
  | {
      status: 'pending';
    };

type ValidatedCliSession = {
  accountId: string;
  accountName: string;
  accountSlug: string | null;
  accountType: 'personal' | 'team';
  sessionExpiresAt: number | null;
  subscriptionStatus: string | null;
  userEmail: string | null;
  userId: string;
};

type SessionWhoAmIErrorPayload = {
  code?: string;
  error?: string;
};

export async function loginWithCloudHandoff(
  options: { browser?: boolean } = {},
): Promise<AuthLoginReport> {
  await assertLocalConfigWritable();
  const cliVersion = await readCurrentCliVersion();
  const [baseUrl, apiBaseUrlState] = await Promise.all([
    requireHostedBaseUrl(),
    resolveApiBaseUrlState(),
  ]);
  const started = await startCloudAuthLogin(baseUrl);

  process.stdout.write(
    formatCloudAuthLoginPrompt({ ...started, browser: options.browser }),
  );
  if (options.browser !== false) {
    const didOpen = await openCloudAuthVerificationUrl(started.verificationUrl);
    if (!didOpen) {
      process.stdout.write(
        'Could not open a browser automatically. Open the URL above to continue.\n',
      );
    }
  }
  process.stdout.write('Waiting for approval...\n');

  const handoffPayload = await waitForCloudAuthLogin({
    apiBaseUrl: baseUrl,
    expiresAt: started.expiresAt,
    pollIntervalSeconds: started.pollIntervalSeconds,
    pollSecret: started.pollSecret,
    requestId: started.requestId,
  });
  await setLocalSession({
    cliVersion,
    accountId: handoffPayload.accountId,
    accountName: handoffPayload.accountName,
    accountSlug: handoffPayload.accountSlug,
    accountType: handoffPayload.accountType,
    apiBaseUrl: baseUrl,
    cliSessionToken: handoffPayload.cliSessionToken,
    sessionExpiresAt: handoffPayload.sessionExpiresAt,
    userEmail: handoffPayload.userEmail,
    userId: handoffPayload.userId,
    persistApiBaseUrl: apiBaseUrlState.source !== 'env',
  });

  // The credential is inactive until this acknowledgement. Never send it if
  // the atomic local save fails, and never delete a delivered credential merely
  // because the acknowledgement response was lost.
  await acknowledgeCloudAuthLogin({
    apiBaseUrl: baseUrl,
    requestId: started.requestId,
    pollSecret: started.pollSecret,
    cliSessionToken: handoffPayload.cliSessionToken,
  });
  const validated = await validateCliSession({
    apiBaseUrl: baseUrl,
    cliSessionToken: handoffPayload.cliSessionToken,
  });

  return {
    accountId: validated.accountId,
    accountName: validated.accountName,
    accountSlug: validated.accountSlug,
    accountType: validated.accountType,
    apiBaseUrl: baseUrl,
    ok: true,
    userEmail: validated.userEmail,
    userId: validated.userId,
  };
}

export function formatCloudAuthLoginPrompt(input: {
  browser?: boolean;
  verificationUrl: string;
}): string {
  return [
    ...(input.browser === false
      ? ['Open this URL in your browser to connect PostPlus:']
      : [
          'Opening browser for authentication...',
          'If browser does not open, visit:',
        ]),
    input.verificationUrl,
    '',
  ].join('\n');
}

export async function startCloudAuthLogin(apiBaseUrl: string) {
  const compatibilityHeaders = await buildPostPlusClientCompatibilityHeaders();
  const response = await fetch(
    `${apiBaseUrl}/api/postplus-cli/auth/login/start`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...compatibilityHeaders,
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  const payload: unknown = await response.json();

  if (!response.ok) {
    // The Web start route rejects compatibility before creating a request.
    // Only this pre-start boundary may update and replay auth login. Poll/ACK
    // must not trigger a new authorization after the user has already begun.
    const compatibilityError = readPostPlusCompatibilityError(payload);
    if (compatibilityError) throw compatibilityError;
    throw new Error(formatRemoteAuthLoginError(payload));
  }

  if (!isCliAuthLoginStartSuccessPayload(payload)) {
    throw new Error('PostPlus CLI sign-in start returned incomplete data.');
  }

  assertCloudAuthVerificationUrl(payload.verificationUrl);
  return payload;
}

export function resolveCloudAuthBrowserCommand(
  verificationUrl: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } | null {
  assertCloudAuthVerificationUrl(verificationUrl);
  const command = env.POSTPLUS_CLI_AUTH_OPEN_URL_COMMAND?.trim();

  if (command) {
    return { command, args: [verificationUrl] };
  }

  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [verificationUrl] };
    case 'win32':
      return {
        command: 'rundll32.exe',
        args: ['url.dll,FileProtocolHandler', verificationUrl],
      };
    case 'linux':
      return env.DISPLAY || env.WAYLAND_DISPLAY
        ? { command: 'xdg-open', args: [verificationUrl] }
        : null;
    default:
      return null;
  }
}

export async function openCloudAuthVerificationUrl(
  verificationUrl: string,
): Promise<boolean> {
  const opener = resolveCloudAuthBrowserCommand(verificationUrl);
  if (!opener) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    spawn(opener.command, opener.args, {
      shell: false,
      stdio: 'ignore',
      timeout: CLI_AUTH_BROWSER_OPEN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
    })
      .once('error', () => resolve(false))
      .once('exit', (code) => resolve(code === 0));
  }).catch(() => false);
}

function assertCloudAuthVerificationUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PostPlus CLI sign-in returned an invalid browser URL.');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new Error('PostPlus CLI sign-in returned an invalid browser URL.');
  }
}

async function waitForCloudAuthLogin(input: {
  apiBaseUrl: string;
  expiresAt: string;
  pollIntervalSeconds: number;
  pollSecret: string;
  requestId: string;
}) {
  const expiresAtMs = Date.parse(input.expiresAt);
  const deadlineMs = Number.isFinite(expiresAtMs)
    ? expiresAtMs
    : Date.now() + CLI_AUTH_LOGIN_POLL_BUDGET_MS;
  const pollIntervalMs = Math.max(1000, input.pollIntervalSeconds * 1000);

  while (Date.now() < deadlineMs) {
    const payload = await pollCloudAuthLogin(input);

    if (payload.status === 'completed') {
      return payload;
    }

    await delay(pollIntervalMs);
  }

  throw new Error('Timed out waiting for the cloud sign-in handoff.');
}

export async function pollCloudAuthLogin(input: {
  apiBaseUrl: string;
  pollSecret: string;
  requestId: string;
}) {
  const { response, payload } = await readRepeatableHandoffResponse({
    apiBaseUrl: input.apiBaseUrl,
    action: 'poll',
    body: { pollSecret: input.pollSecret, requestId: input.requestId },
  });
  if (!response.ok) {
    throw new Error(formatRemoteAuthLoginError(payload));
  }

  if (isCliAuthLoginCompletedPayload(payload)) {
    return payload;
  }

  if (isCliAuthLoginPendingPayload(payload)) {
    return payload;
  }

  throw new Error('PostPlus CLI sign-in poll returned incomplete data.');
}

export async function validateCliSession(input: {
  apiBaseUrl: string;
  cliSessionToken: string;
}): Promise<ValidatedCliSession> {
  const response = await sendAuthedCloudRequest({
    auth: input,
    pathName: '/api/postplus-cli/auth/whoami',
  });
  const payload = (await response.json()) as
    | SessionWhoAmIErrorPayload
    | ValidatedCliSession;

  if (!response.ok) {
    throw new Error(
      formatCliSessionAuthError(payload as SessionWhoAmIErrorPayload),
    );
  }

  if (!isValidatedCliSessionPayload(payload)) {
    throw new Error('PostPlus CLI auth validation returned incomplete data.');
  }

  return payload;
}

export async function acknowledgeCloudAuthLogin(input: {
  apiBaseUrl: string;
  requestId: string;
  pollSecret: string;
  cliSessionToken: string;
}): Promise<void> {
  const { response, payload } = await readRepeatableHandoffResponse({
    apiBaseUrl: input.apiBaseUrl,
    action: 'acknowledge',
    body: {
      requestId: input.requestId,
      pollSecret: input.pollSecret,
      cliSessionToken: input.cliSessionToken,
    },
  });
  if (
    response.ok &&
    typeof payload === 'object' &&
    payload !== null &&
    'ok' in payload &&
    payload.ok === true
  )
    return;
  if (!response.ok) throw new Error(formatRemoteAuthLoginError(payload));
  throw new Error(
    'PostPlus did not confirm credential delivery. The CLI has not reported a successful connection.',
  );
}

// Only the two repeatable handoff operations use this bounded transport retry.
// Start and browser decisions are never automatically reissued here.
async function readRepeatableHandoffResponse(input: {
  apiBaseUrl: string;
  action: 'poll' | 'acknowledge';
  body: { requestId: string; pollSecret: string; cliSessionToken?: string };
}): Promise<{ response: Response; payload: unknown }> {
  const headers = await buildPostPlusClientCompatibilityHeaders();
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetch(
        `${input.apiBaseUrl}/api/postplus-cli/auth/login/${input.action}`,
        {
          method: 'POST',
          headers: {
            ...headers,
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify(input.body),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      if (attempt === 0) continue;
      break;
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (response.status >= 400 && response.status < 500)
        return { response, payload: null };
      if (attempt === 0) continue;
      break;
    }
    if (response.status >= 500) {
      if (attempt === 0) continue;
      break;
    }
    return { response, payload };
  }
  throw new Error(
    input.action === 'acknowledge'
      ? 'Your credential was saved, but PostPlus could not confirm the connection. Run `postplus auth validate` to check cloud access; no new login was started.'
      : 'PostPlus could not read the approval response after one retry. No new login was started.',
  );
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

  const compatibilityError = formatPostPlusCompatibilityError(payload);

  if (compatibilityError) {
    return compatibilityError;
  }

  if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
    return payload.error;
  }

  return 'Failed to validate the browser session for PostPlus CLI.';
}

function isCliAuthLoginStartSuccessPayload(
  payload: unknown,
): payload is Extract<CliAuthLoginStartPayload, { requestId: string }> {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'requestId' in payload &&
    'pollSecret' in payload &&
    'userCode' in payload &&
    'verificationUrl' in payload &&
    'expiresAt' in payload &&
    'pollIntervalSeconds' in payload &&
    typeof payload.requestId === 'string' &&
    typeof payload.pollSecret === 'string' &&
    typeof payload.userCode === 'string' &&
    typeof payload.verificationUrl === 'string' &&
    typeof payload.expiresAt === 'string' &&
    typeof payload.pollIntervalSeconds === 'number'
  );
}

function isCliAuthLoginCompletedPayload(
  payload: unknown,
): payload is Extract<CliAuthLoginPollPayload, { status: 'completed' }> {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'status' in payload &&
    payload.status === 'completed' &&
    'cliSessionToken' in payload &&
    'accountId' in payload &&
    'accountName' in payload &&
    'accountSlug' in payload &&
    'accountType' in payload &&
    'userId' in payload &&
    'sessionExpiresAt' in payload &&
    'subscriptionStatus' in payload &&
    'userEmail' in payload &&
    typeof payload.cliSessionToken === 'string' &&
    typeof payload.accountId === 'string' &&
    typeof payload.accountName === 'string' &&
    (payload.accountSlug === null || typeof payload.accountSlug === 'string') &&
    (payload.accountType === 'personal' || payload.accountType === 'team') &&
    (payload.sessionExpiresAt === null ||
      (typeof payload.sessionExpiresAt === 'number' &&
        Number.isFinite(payload.sessionExpiresAt))) &&
    (payload.subscriptionStatus === null ||
      typeof payload.subscriptionStatus === 'string') &&
    (payload.userEmail === null || typeof payload.userEmail === 'string') &&
    typeof payload.userId === 'string'
  );
}

function isCliAuthLoginPendingPayload(
  payload: unknown,
): payload is Extract<CliAuthLoginPollPayload, { status: 'pending' }> {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'status' in payload &&
    payload.status === 'pending'
  );
}

function isValidatedCliSessionPayload(
  payload: SessionWhoAmIErrorPayload | ValidatedCliSession,
): payload is ValidatedCliSession {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { accountId?: unknown }).accountId === 'string' &&
    typeof (payload as { accountName?: unknown }).accountName === 'string' &&
    ((payload as { accountSlug?: unknown }).accountSlug === null ||
      typeof (payload as { accountSlug?: unknown }).accountSlug === 'string') &&
    ((payload as { accountType?: unknown }).accountType === 'personal' ||
      (payload as { accountType?: unknown }).accountType === 'team') &&
    typeof (payload as { userId?: unknown }).userId === 'string'
  );
}

function formatRemoteAuthLoginError(payload: unknown) {
  const compatibilityError = formatPostPlusCompatibilityError(payload);

  if (compatibilityError) {
    return compatibilityError;
  }

  return typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'string' &&
    payload.error.trim().length > 0
    ? payload.error
    : 'PostPlus CLI sign-in failed.';
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
