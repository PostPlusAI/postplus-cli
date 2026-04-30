import { refreshRemoteAuthSession } from './auth-session.js';
import { clearAuthState, generateAuthStatusReport } from './auth.js';
import { requireHostedBaseUrl } from './hosted-release.js';
import {
  resolveAccessTokenState,
  resolveRefreshTokenState,
} from './local-state.js';

export type AuthRefreshReport = {
  accountId: string;
  apiBaseUrl: string;
  ok: boolean;
  subscriptionStatus: string | null;
  userEmail: string | null;
  userId: string;
};

export async function refreshRemoteAuth(): Promise<AuthRefreshReport> {
  const refreshed = await refreshRemoteAuthSession();

  return {
    accountId: refreshed.accountId,
    apiBaseUrl: refreshed.apiBaseUrl,
    ok: true,
    subscriptionStatus: refreshed.subscriptionStatus,
    userEmail: refreshed.userEmail,
    userId: refreshed.userId,
  };
}

export function formatAuthRefreshReport(report: AuthRefreshReport): string {
  return [
    'PostPlus CLI auth refresh',
    '',
    `Remote auth: ${report.ok ? 'OK' : 'FAILED'}`,
    `PostPlus Cloud: ${report.apiBaseUrl}`,
    `Account: ${report.accountId}`,
    `User: ${report.userEmail ?? report.userId}`,
    `Subscription: ${report.subscriptionStatus ?? 'unknown'}`,
  ].join('\n');
}

export async function revokeRemoteAuth() {
  const [apiBaseUrl, accessTokenState, refreshTokenState] = await Promise.all([
    requireHostedBaseUrl(),
    resolveAccessTokenState(),
    resolveRefreshTokenState(),
  ]);

  if (!accessTokenState.present || !accessTokenState.value) {
    throw new Error('Run `postplus auth login` before revoking PostPlus auth.');
  }

  if (!refreshTokenState.present || !refreshTokenState.value) {
    throw new Error('Run `postplus auth login` before revoking PostPlus auth.');
  }

  const response = await fetch(`${apiBaseUrl}/api/postplus-cli/auth/revoke`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessTokenState.value}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      refreshToken: refreshTokenState.value,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = (await response.json()) as
    | {
        ok: boolean;
      }
    | {
        error?: string;
      };

  if (!response.ok) {
    throw new Error(
      'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : 'Failed to revoke remote PostPlus auth.',
    );
  }

  return clearAuthState();
}

export async function revokeRemoteAuthAndReport() {
  await revokeRemoteAuth();
  return generateAuthStatusReport();
}
