import { requireHostedBaseUrl } from './hosted-release.js';
import { resolveAccessTokenState } from './local-state.js';

export type AuthValidateReport = {
  accountId: string;
  apiBaseUrl: string;
  ok: boolean;
  sessionExpiresAt: number | null;
  source: 'env' | 'config';
  subscriptionStatus: string | null;
  userEmail: string | null;
  userId: string;
};

export async function validateRemoteAuth(): Promise<AuthValidateReport> {
  const [apiBaseUrl, accessTokenState] = await Promise.all([
    requireHostedBaseUrl(),
    resolveAccessTokenState(),
  ]);

  if (!accessTokenState.present || !accessTokenState.value) {
    throw new Error(
      'Run `postplus auth login` before validating PostPlus auth.',
    );
  }

  const response = await fetch(`${apiBaseUrl}/api/postplus-cli/auth/whoami`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessTokenState.value}`,
    },
    signal: AbortSignal.timeout(15000),
  });
  const payload = (await response.json()) as
    | {
        accountId: string;
        sessionExpiresAt: number | null;
        subscriptionStatus: string | null;
        userEmail: string | null;
        userId: string;
      }
    | {
        error?: string;
      };

  if (!response.ok) {
    throw new Error(
      'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : 'Failed to validate remote PostPlus auth.',
    );
  }

  const successPayload = payload as {
    accountId: string;
    sessionExpiresAt: number | null;
    subscriptionStatus: string | null;
    userEmail: string | null;
    userId: string;
  };

  return {
    accountId: successPayload.accountId,
    apiBaseUrl,
    ok: true,
    sessionExpiresAt: successPayload.sessionExpiresAt,
    source:
      accessTokenState.source === 'missing'
        ? 'config'
        : accessTokenState.source,
    subscriptionStatus: successPayload.subscriptionStatus,
    userEmail: successPayload.userEmail,
    userId: successPayload.userId,
  };
}

export function formatAuthValidateReport(report: AuthValidateReport): string {
  return [
    'PostPlus CLI auth validate',
    '',
    `Remote auth: ${report.ok ? 'OK' : 'FAILED'}`,
    `PostPlus Cloud: ${report.apiBaseUrl}`,
    `Account: ${report.accountId}`,
    `User: ${report.userEmail ?? report.userId}`,
    `Subscription: ${report.subscriptionStatus ?? 'unknown'}`,
    `Session expires at: ${
      typeof report.sessionExpiresAt === 'number'
        ? new Date(report.sessionExpiresAt * 1000).toISOString()
        : 'unknown'
    }`,
  ].join('\n');
}
