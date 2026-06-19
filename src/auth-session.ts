import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import {
  formatPostPlusCompatibilityError,
  writeCurrentCliVersionToLocalConfig,
} from './client-compatibility.js';
import { requireHostedBaseUrl } from './hosted-release.js';
import { resolveCliSessionTokenState, setLocalSession } from './local-state.js';

export type FreshRemoteAuth = {
  apiBaseUrl: string;
  cliSessionToken: string;
  refreshed: boolean;
  source: 'config';
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
  });
  await writeCurrentCliVersionToLocalConfig();

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
