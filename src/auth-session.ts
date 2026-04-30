import { requireHostedBaseUrl } from './hosted-release.js';
import {
  readLocalConfig,
  resolveAccessTokenState,
  resolveRefreshTokenState,
  setLocalSession,
} from './local-state.js';

export const AUTH_SESSION_REFRESH_LEEWAY_SECONDS = 60;

export type FreshRemoteAuth = {
  accessToken: string;
  apiBaseUrl: string;
  refreshed: boolean;
  source: 'config';
};

export type RemoteAuthRefreshResult = {
  accessToken: string;
  accountId: string;
  apiBaseUrl: string;
  refreshToken: string;
  sessionExpiresAt: number | null;
  subscriptionStatus: string | null;
  userEmail: string | null;
  userId: string;
};

type RemoteAuthRefreshPayload =
  | {
      accessToken: string;
      accountId: string;
      refreshToken: string;
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
  const [apiBaseUrl, accessTokenState, refreshTokenState, config] =
    await Promise.all([
      requireHostedBaseUrl(),
      resolveAccessTokenState(),
      resolveRefreshTokenState(),
      readLocalConfig(),
    ]);

  if (!refreshTokenState.present || !refreshTokenState.value) {
    if (!accessTokenState.present || !accessTokenState.value) {
      throw new Error(
        'Run `postplus auth login` before validating PostPlus auth.',
      );
    }

    return {
      accessToken: accessTokenState.value,
      apiBaseUrl,
      refreshed: false,
      source: 'config',
    };
  }

  const existingAccessToken = accessTokenState.value;
  const decodedTokenExpiresAt = existingAccessToken
    ? decodeAccessTokenExpiration(existingAccessToken)
    : null;
  const tokenExpiresAt =
    typeof decodedTokenExpiresAt === 'number'
      ? decodedTokenExpiresAt
      : typeof config?.sessionExpiresAt === 'number'
        ? config.sessionExpiresAt
        : null;

  const shouldRefresh =
    options.forceRefresh === true ||
    !accessTokenState.present ||
    !accessTokenState.value ||
    isExpiringSoon(tokenExpiresAt);

  if (!shouldRefresh) {
    if (!existingAccessToken) {
      throw new Error(
        'Run `postplus auth login` before validating PostPlus auth.',
      );
    }

    return {
      accessToken: existingAccessToken,
      apiBaseUrl,
      refreshed: false,
      source: 'config',
    };
  }

  const refreshed = await refreshRemoteAuthSession({
    accessToken: accessTokenState.value,
    apiBaseUrl,
    refreshToken: refreshTokenState.value,
  });

  return {
    accessToken: refreshed.accessToken,
    apiBaseUrl,
    refreshed: true,
    source: 'config',
  };
}

export async function refreshRemoteAuthSession(input?: {
  accessToken?: string | null;
  apiBaseUrl?: string;
  refreshToken?: string;
}): Promise<RemoteAuthRefreshResult> {
  const [apiBaseUrl, accessTokenState, refreshTokenState] = await Promise.all([
    input?.apiBaseUrl ?? requireHostedBaseUrl(),
    input?.accessToken === undefined ? resolveAccessTokenState() : null,
    input?.refreshToken === undefined ? resolveRefreshTokenState() : null,
  ]);
  const accessToken =
    input?.accessToken === undefined
      ? accessTokenState?.value
      : input.accessToken;
  const refreshToken =
    input?.refreshToken === undefined
      ? refreshTokenState?.value
      : input.refreshToken;

  if (!refreshToken) {
    throw new Error(
      'Run `postplus auth login` before refreshing PostPlus auth.',
    );
  }

  const response = await fetch(`${apiBaseUrl}/api/postplus-cli/auth/refresh`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      refreshToken,
    }),
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
    throw new Error(
      'PostPlus auth refresh returned incomplete session tokens.',
    );
  }

  await setLocalSession({
    accessToken: payload.accessToken,
    accountId: payload.accountId,
    apiBaseUrl,
    refreshToken: payload.refreshToken,
    sessionExpiresAt: payload.sessionExpiresAt,
    userEmail: payload.userEmail,
    userId: payload.userId,
  });

  return {
    ...payload,
    apiBaseUrl,
  };
}

export function decodeAccessTokenExpiration(
  accessToken: string,
): number | null {
  try {
    const [, payload] = accessToken.split('.');

    if (!payload) {
      return null;
    }

    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { exp?: unknown };

    return typeof decoded.exp === 'number' ? decoded.exp : null;
  } catch {
    return null;
  }
}

function isExpiringSoon(expiresAt: number | null): boolean {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1_000);
  return expiresAt - nowSeconds <= AUTH_SESSION_REFRESH_LEEWAY_SECONDS;
}

function isRemoteAuthRefreshSuccessPayload(
  payload: RemoteAuthRefreshPayload,
): payload is Exclude<RemoteAuthRefreshPayload, { error?: string }> {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { accessToken?: unknown }).accessToken === 'string' &&
    (payload as { accessToken: string }).accessToken.trim().length > 0 &&
    typeof (payload as { refreshToken?: unknown }).refreshToken === 'string' &&
    (payload as { refreshToken: string }).refreshToken.trim().length > 0 &&
    typeof (payload as { accountId?: unknown }).accountId === 'string' &&
    typeof (payload as { userId?: unknown }).userId === 'string'
  );
}
