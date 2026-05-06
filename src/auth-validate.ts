import { resolveFreshRemoteAuth } from './auth-session.js';
import {
  buildPostPlusClientCompatibilityHeaders,
  formatPostPlusCompatibilityError,
} from './client-compatibility.js';
import { readSubscriptionStatusField } from './subscription-status.js';

export type AuthValidateReport = {
  accountId: string;
  apiBaseUrl: string;
  ok: boolean;
  source: 'config';
  subscriptionStatus?: unknown;
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

  const payload = (await response.json()) as Record<string, unknown>;

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

  const hasSubscriptionStatus = Object.prototype.hasOwnProperty.call(
    payload,
    'subscriptionStatus',
  );
  const accountId = readRequiredString(payload, 'accountId');
  const userId = readRequiredString(payload, 'userId');
  const userEmail = readNullableString(payload, 'userEmail');

  return {
    accountId,
    apiBaseUrl: auth.apiBaseUrl,
    ok: true,
    source: auth.source,
    ...(hasSubscriptionStatus
      ? { subscriptionStatus: payload.subscriptionStatus }
      : {}),
    userEmail,
    userId,
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
    `Subscription: ${readSubscriptionStatusField(report).label}`,
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

function readRequiredString(
  payload: Record<string, unknown>,
  fieldName: string,
): string {
  const value = payload[fieldName];

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      `Invalid PostPlus auth response: ${fieldName} must be a non-empty string.`,
    );
  }

  return value.trim();
}

function readNullableString(
  payload: Record<string, unknown>,
  fieldName: string,
): string | null {
  const value = payload[fieldName];

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(
      `Invalid PostPlus auth response: ${fieldName} must be a string or null.`,
    );
  }

  return value;
}
