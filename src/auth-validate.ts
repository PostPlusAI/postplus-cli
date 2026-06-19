import { formatAccountBindingLines } from './account-binding-display.js';
import { resolveFreshRemoteAuth } from './auth-session.js';
import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import { formatPostPlusCompatibilityError } from './client-compatibility.js';
import { readSubscriptionStatusField } from './subscription-status.js';

export type AuthValidateReport = {
  accountId: string;
  accountName: string;
  accountSlug: string | null;
  accountType: 'personal' | 'team';
  apiBaseUrl: string;
  ok: boolean;
  source: 'config';
  subscriptionStatus?: unknown;
  userEmail: string | null;
  userId: string;
};

export async function validateRemoteAuth(): Promise<AuthValidateReport> {
  const auth = await resolveFreshRemoteAuth();
  const response = await sendAuthedCloudRequest({
    auth,
    pathName: '/api/postplus-cli/auth/whoami',
    retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
  });

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
  const accountName = readRequiredString(payload, 'accountName');
  const accountSlug = readNullableString(payload, 'accountSlug');
  const accountType = readAccountType(payload);
  const userId = readRequiredString(payload, 'userId');
  const userEmail = readNullableString(payload, 'userEmail');

  return {
    accountId,
    accountName,
    accountSlug,
    accountType,
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
    ...formatAccountBindingLines(report),
    `User: ${report.userEmail ?? report.userId}`,
    `Subscription: ${readSubscriptionStatusField(report).label}`,
  ].join('\n');
}

function readAccountType(
  payload: Record<string, unknown>,
): 'personal' | 'team' {
  const value = payload.accountType;

  if (value !== 'personal' && value !== 'team') {
    throw new Error(
      'Invalid PostPlus auth response: accountType must be personal or team.',
    );
  }

  return value;
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
