import { requireHostedBaseUrl } from './hosted-release.js';
import {
  resolveCliSessionTokenState,
  setLocalSession,
} from './local-state.js';

export type FreshRemoteAuth = {
  apiBaseUrl: string;
  cliSessionToken: string;
  refreshed: boolean;
  source: 'config';
};

export type RemoteAuthRefreshResult = {
  accountId: string;
  apiBaseUrl: string;
  cliSessionToken: string;
  sessionExpiresAt: number | null;
  subscriptionStatus: string | null;
  userEmail: string | null;
  userId: string;
};

type RemoteAuthRefreshPayload =
  | {
      accountId: string;
      cliSessionToken: string;
      sessionExpiresAt: number | null;
      subscriptionStatus: string | null;
      userEmail: string | null;
      userId: string;
    }
  | {
      error?: string;
    };

export async function resolveFreshRemoteAuth(
  options: {
    forceRefresh?: boolean;
  } = {},
): Promise<FreshRemoteAuth> {
  const [apiBaseUrl, cliSessionTokenState] = await Promise.all([
    requireHostedBaseUrl(),
    resolveCliSessionTokenState(),
  ]);

  if (!cliSessionTokenState.present || !cliSessionTokenState.value) {
    throw new Error('Run `postplus auth login` before using PostPlus auth.');
  }

  if (options.forceRefresh === true) {
    const refreshed = await refreshRemoteAuthSession({
      apiBaseUrl,
      cliSessionToken: cliSessionTokenState.value,
    });

    return {
      apiBaseUrl,
      cliSessionToken: refreshed.cliSessionToken,
      refreshed: true,
      source: 'config',
    };
  }

  return {
    apiBaseUrl,
    cliSessionToken: cliSessionTokenState.value,
    refreshed: false,
    source: 'config',
  };
}

export async function refreshRemoteAuthSession(input?: {
  apiBaseUrl?: string;
  cliSessionToken?: string;
}): Promise<RemoteAuthRefreshResult> {
  const [apiBaseUrl, cliSessionTokenState] = await Promise.all([
    input?.apiBaseUrl ?? requireHostedBaseUrl(),
    input?.cliSessionToken === undefined ? resolveCliSessionTokenState() : null,
  ]);
  const cliSessionToken =
    input?.cliSessionToken === undefined
      ? cliSessionTokenState?.value
      : input.cliSessionToken;

  if (!cliSessionToken) {
    throw new Error('Run `postplus auth login` before refreshing PostPlus auth.');
  }

  const response = await fetch(`${apiBaseUrl}/api/postplus-cli/auth/refresh`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${cliSessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(15000),
  });
  const payload = (await response.json()) as RemoteAuthRefreshPayload;

  if (!response.ok) {
    throw new Error(
      'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : 'Failed to refresh remote PostPlus auth.',
    );
  }

  if (!isRemoteAuthRefreshSuccessPayload(payload)) {
    throw new Error('PostPlus auth refresh returned incomplete session data.');
  }

  await setLocalSession({
    accountId: payload.accountId,
    apiBaseUrl,
    cliSessionToken: payload.cliSessionToken,
    sessionExpiresAt: payload.sessionExpiresAt,
    userEmail: payload.userEmail,
    userId: payload.userId,
  });

  return {
    ...payload,
    apiBaseUrl,
  };
}

function isRemoteAuthRefreshSuccessPayload(
  payload: RemoteAuthRefreshPayload,
): payload is Exclude<RemoteAuthRefreshPayload, { error?: string }> {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { cliSessionToken?: unknown }).cliSessionToken ===
      'string' &&
    (payload as { cliSessionToken: string }).cliSessionToken.trim().length > 0 &&
    typeof (payload as { accountId?: unknown }).accountId === 'string' &&
    typeof (payload as { userId?: unknown }).userId === 'string'
  );
}
