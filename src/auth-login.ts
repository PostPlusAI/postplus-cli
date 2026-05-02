import {
  buildPostPlusClientCompatibilityHeaders,
  formatPostPlusClientUpgradeError,
  writeCurrentCliVersionToLocalConfig,
} from './client-compatibility.js';
import { requireHostedBaseUrl } from './hosted-release.js';
import { setLocalSession } from './local-state.js';

export const CLI_AUTH_LOGIN_TIMEOUT_MS = 30 * 60 * 1000;

export type AuthLoginReport = {
  accountId: string;
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
  sessionExpiresAt: number | null;
  subscriptionStatus: string | null;
  userEmail: string | null;
  userId: string;
};

type SessionWhoAmIErrorPayload = {
  code?: string;
  error?: string;
};

export async function loginWithCloudHandoff(): Promise<AuthLoginReport> {
  const baseUrl = await requireHostedBaseUrl();
  const started = await startCloudAuthLogin(baseUrl);

  process.stdout.write(
    [
      'PostPlus CLI login',
      '',
      'Open this URL in your browser to continue:',
      started.verificationUrl,
      '',
      `Code: ${started.userCode}`,
      '',
      'Waiting for browser sign-in...',
      '',
    ].join('\n'),
  );

  const handoffPayload = await waitForCloudAuthLogin({
    apiBaseUrl: baseUrl,
    expiresAt: started.expiresAt,
    pollIntervalSeconds: started.pollIntervalSeconds,
    pollSecret: started.pollSecret,
    requestId: started.requestId,
  });
  const validated = await validateCliSession({
    apiBaseUrl: baseUrl,
    cliSessionToken: handoffPayload.cliSessionToken,
  });

  await setLocalSession({
    accountId: validated.accountId,
    apiBaseUrl: baseUrl,
    cliSessionToken: handoffPayload.cliSessionToken,
    sessionExpiresAt:
      validated.sessionExpiresAt ?? handoffPayload.sessionExpiresAt ?? null,
    userEmail: validated.userEmail,
    userId: validated.userId,
  });
  await writeCurrentCliVersionToLocalConfig();

  return {
    accountId: validated.accountId,
    apiBaseUrl: baseUrl,
    ok: true,
    userEmail: validated.userEmail,
    userId: validated.userId,
  };
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
  const payload = (await response.json()) as CliAuthLoginStartPayload;

  if (!response.ok) {
    throw new Error(formatRemoteAuthLoginError(payload));
  }

  if (!isCliAuthLoginStartSuccessPayload(payload)) {
    throw new Error('PostPlus CLI sign-in start returned incomplete data.');
  }

  return payload;
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
    : Date.now() + CLI_AUTH_LOGIN_TIMEOUT_MS;
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
  const compatibilityHeaders = await buildPostPlusClientCompatibilityHeaders();
  const response = await fetch(
    `${input.apiBaseUrl}/api/postplus-cli/auth/login/poll`,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...compatibilityHeaders,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        pollSecret: input.pollSecret,
        requestId: input.requestId,
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const payload = (await response.json()) as CliAuthLoginPollPayload;

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
  const compatibilityHeaders = await buildPostPlusClientCompatibilityHeaders();
  const response = await fetch(
    `${input.apiBaseUrl}/api/postplus-cli/auth/whoami`,
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...compatibilityHeaders,
        authorization: `Bearer ${input.cliSessionToken}`,
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

  if (payload.code === 'postplus_client_upgrade_required') {
    return formatPostPlusClientUpgradeError(payload);
  }

  if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
    return payload.error;
  }

  return 'Failed to validate the browser session for PostPlus CLI.';
}

function isCliAuthLoginStartSuccessPayload(
  payload: CliAuthLoginStartPayload,
): payload is Extract<CliAuthLoginStartPayload, { requestId: string }> {
  return (
    'requestId' in payload &&
    typeof payload.requestId === 'string' &&
    typeof payload.pollSecret === 'string' &&
    typeof payload.userCode === 'string' &&
    typeof payload.verificationUrl === 'string' &&
    typeof payload.expiresAt === 'string' &&
    typeof payload.pollIntervalSeconds === 'number'
  );
}

function isCliAuthLoginCompletedPayload(
  payload: CliAuthLoginPollPayload,
): payload is Extract<CliAuthLoginPollPayload, { status: 'completed' }> {
  return (
    'status' in payload &&
    payload.status === 'completed' &&
    typeof payload.cliSessionToken === 'string' &&
    typeof payload.accountId === 'string' &&
    typeof payload.userId === 'string'
  );
}

function isCliAuthLoginPendingPayload(
  payload: CliAuthLoginPollPayload,
): payload is Extract<CliAuthLoginPollPayload, { status: 'pending' }> {
  return 'status' in payload && payload.status === 'pending';
}

function formatRemoteAuthLoginError(
  payload: CliAuthLoginStartPayload | CliAuthLoginPollPayload,
) {
  if ('code' in payload && payload.code === 'postplus_client_upgrade_required') {
    return formatPostPlusClientUpgradeError(payload);
  }

  return 'error' in payload &&
    typeof payload.error === 'string' &&
    payload.error.trim().length > 0
    ? payload.error
    : 'PostPlus CLI sign-in failed.';
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
