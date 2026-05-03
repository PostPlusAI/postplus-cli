import { resolveFreshRemoteAuth } from './auth-session.js';
import {
  buildPostPlusClientCompatibilityHeaders,
  formatPostPlusCompatibilityError,
} from './client-compatibility.js';

export type AuthValidateReport = {
  accountId: string;
  apiBaseUrl: string;
  ok: boolean;
  source: 'config';
  subscriptionStatus: string | null;
  userEmail: string | null;
  userId: string;
};

export async function validateRemoteAuth(): Promise<AuthValidateReport> {
  let auth = await resolveFreshRemoteAuth();
  let response = await fetchWhoami(auth);

  if (response.status === 401) {
    auth = await resolveFreshRemoteAuth({
      forceRefresh: true,
    });
    response = await fetchWhoami(auth);
  }

  const payload = (await response.json()) as
    | {
        accountId: string;
        subscriptionStatus: string | null;
        userEmail: string | null;
        userId: string;
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
        : 'Failed to validate remote PostPlus auth.',
    );
  }

  const successPayload = payload as {
    accountId: string;
    subscriptionStatus: string | null;
    userEmail: string | null;
    userId: string;
  };

  return {
    accountId: successPayload.accountId,
    apiBaseUrl: auth.apiBaseUrl,
    ok: true,
    source: auth.source,
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
  ].join('\n');
}

async function fetchWhoami(input: {
  apiBaseUrl: string;
  cliSessionToken: string;
}) {
  const compatibilityHeaders = await buildPostPlusClientCompatibilityHeaders();

  return fetch(`${input.apiBaseUrl}/api/postplus-cli/auth/whoami`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...compatibilityHeaders,
      authorization: `Bearer ${input.cliSessionToken}`,
    },
    signal: AbortSignal.timeout(15000),
  });
}
