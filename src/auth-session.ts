import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import {
  formatPostPlusCompatibilityError,
  writeCurrentCliVersionToLocalConfig,
} from './client-compatibility.js';
import { requireHostedBaseUrl } from './hosted-release.js';
import {
  readLocalConfig,
  resolveApiBaseUrlState,
  resolveCliSessionTokenState,
  setLocalSession,
} from './local-state.js';
import { clearUpdateCheckCache } from './update-check.js';

export type FreshRemoteAuth = {
  apiBaseUrl: string;
  cliSessionToken: string;
  refreshed: boolean;
  source: 'env' | 'config' | 'default';
};

export type RemoteAuthRefreshResult = {
  accountId: string;
  accountName: string;
  accountSlug: string | null;
  accountType: 'personal' | 'team';
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
      accountName: string;
      accountSlug: string | null;
      accountType: 'personal' | 'team';
      cliSessionToken: string;
      sessionExpiresAt: number | null;
      subscriptionStatus: string | null;
      userEmail: string | null;
      userId: string;
    }
  | {
      code?: string;
      error?: string;
      compatibility?: unknown;
    };

export async function resolveFreshRemoteAuth(
  options: {
    forceRefresh?: boolean;
  } = {},
): Promise<FreshRemoteAuth> {
  const [apiBaseUrl, apiBaseUrlState, cliSessionTokenState, config] =
    await Promise.all([
      requireHostedBaseUrl(),
      resolveApiBaseUrlState(),
      resolveCliSessionTokenState(),
      readLocalConfig(),
    ]);

  if (!cliSessionTokenState.present || !cliSessionTokenState.value) {
    throw new Error('Run `postplus auth login` before using PostPlus auth.');
  }

  const sessionApiBaseUrl = config?.sessionApiBaseUrl ?? config?.apiBaseUrl;
  if (
    sessionApiBaseUrl &&
    normalizeApiBaseUrl(sessionApiBaseUrl) !== normalizeApiBaseUrl(apiBaseUrl)
  ) {
    throw new Error(
      `The current PostPlus session belongs to ${normalizeApiBaseUrl(sessionApiBaseUrl)}, but this process targets ${normalizeApiBaseUrl(apiBaseUrl)}. Use an isolated POSTPLUS_CONFIG_DIR and log in to the target environment.`,
    );
  }

  if (options.forceRefresh === true) {
    const refreshed = await refreshRemoteAuthSession({
      apiBaseUrl,
      cliSessionToken: cliSessionTokenState.value,
      persistApiBaseUrl: apiBaseUrlState.source !== 'env',
    });

    return {
      apiBaseUrl,
      cliSessionToken: refreshed.cliSessionToken,
      refreshed: true,
      source: apiBaseUrlState.source,
    };
  }

  return {
    apiBaseUrl,
    cliSessionToken: cliSessionTokenState.value,
    refreshed: false,
    source: apiBaseUrlState.source,
  };
}

export async function refreshRemoteAuthSession(input?: {
  apiBaseUrl?: string;
  cliSessionToken?: string;
  persistApiBaseUrl?: boolean;
}): Promise<RemoteAuthRefreshResult> {
  const [apiBaseUrl, apiBaseUrlState, cliSessionTokenState] = await Promise.all(
    [
      input?.apiBaseUrl ?? requireHostedBaseUrl(),
      resolveApiBaseUrlState(),
      input?.cliSessionToken === undefined
        ? resolveCliSessionTokenState()
        : null,
    ],
  );
  const cliSessionToken =
    input?.cliSessionToken === undefined
      ? cliSessionTokenState?.value
      : input.cliSessionToken;

  if (!cliSessionToken) {
    throw new Error(
      'Run `postplus auth login` before refreshing PostPlus auth.',
    );
  }

  const response = await sendAuthedCloudRequest({
    auth: { apiBaseUrl, cliSessionToken },
    body: {},
    method: 'POST',
    pathName: '/api/postplus-cli/auth/refresh',
  });
  const payload = (await response.json()) as RemoteAuthRefreshPayload;

  if (!response.ok) {
    const compatibilityError = formatPostPlusCompatibilityError(payload);

    if (compatibilityError) {
      await clearUpdateCheckCache();
      throw new Error(compatibilityError);
    }

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
    accountName: payload.accountName,
    accountSlug: payload.accountSlug,
    accountType: payload.accountType,
    apiBaseUrl,
    cliSessionToken: payload.cliSessionToken,
    sessionExpiresAt: payload.sessionExpiresAt,
    userEmail: payload.userEmail,
    userId: payload.userId,
    persistApiBaseUrl:
      input?.persistApiBaseUrl ?? apiBaseUrlState.source !== 'env',
  });
  await writeCurrentCliVersionToLocalConfig();

  return {
    ...payload,
    apiBaseUrl,
  };
}

function normalizeApiBaseUrl(value: string): string {
  return new URL(value.trim()).toString().replace(/\/+$/u, '');
}

function isRemoteAuthRefreshSuccessPayload(
  payload: RemoteAuthRefreshPayload,
): payload is Exclude<RemoteAuthRefreshPayload, { error?: string }> {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { cliSessionToken?: unknown }).cliSessionToken ===
      'string' &&
    (payload as { cliSessionToken: string }).cliSessionToken.trim().length >
      0 &&
    typeof (payload as { accountId?: unknown }).accountId === 'string' &&
    typeof (payload as { accountName?: unknown }).accountName === 'string' &&
    ((payload as { accountSlug?: unknown }).accountSlug === null ||
      typeof (payload as { accountSlug?: unknown }).accountSlug === 'string') &&
    ((payload as { accountType?: unknown }).accountType === 'personal' ||
      (payload as { accountType?: unknown }).accountType === 'team') &&
    typeof (payload as { userId?: unknown }).userId === 'string'
  );
}
