import { formatAccountBindingLines } from './account-binding-display.js';
import { refreshRemoteAuthSession } from './auth-session.js';
import { clearAuthState, generateAuthStatusReport } from './auth.js';
import {
  buildPostPlusClientCompatibilityHeaders,
  formatPostPlusCompatibilityError,
} from './client-compatibility.js';
import { requireHostedBaseUrl } from './hosted-release.js';
import { resolveCliSessionTokenState } from './local-state.js';
import { readSubscriptionStatusField } from './subscription-status.js';

export type AuthRefreshReport = {
  accountId: string;
  accountName: string;
  accountSlug: string | null;
  accountType: 'personal' | 'team';
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
    accountName: refreshed.accountName,
    accountSlug: refreshed.accountSlug,
    accountType: refreshed.accountType,
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
    ...formatAccountBindingLines(report),
    `User: ${report.userEmail ?? report.userId}`,
    `Subscription: ${readSubscriptionStatusField(report).label}`,
  ].join('\n');
}

export async function revokeRemoteAuth() {
  const [apiBaseUrl, cliSessionTokenState] = await Promise.all([
    requireHostedBaseUrl(),
    resolveCliSessionTokenState(),
  ]);

  if (!cliSessionTokenState.present || !cliSessionTokenState.value) {
    throw new Error('Run `postplus auth login` before revoking PostPlus auth.');
  }

  const compatibilityHeaders = await buildPostPlusClientCompatibilityHeaders();
  const response = await fetch(`${apiBaseUrl}/api/postplus-cli/auth/revoke`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      ...compatibilityHeaders,
      authorization: `Bearer ${cliSessionTokenState.value}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
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
    const compatibilityError = formatPostPlusCompatibilityError(payload);

    if (compatibilityError) {
      throw new Error(compatibilityError);
    }

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
