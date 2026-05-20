import { formatAccountBindingLines } from './account-binding-display.js';
import {
  clearLocalAuthState,
  getPostPlusConfigPath,
  hasLocalConfigFile,
  maskSecret,
  readLocalConfig,
  resolveApiBaseUrlState,
  resolveLocalSessionState,
  setLocalApiBaseUrl,
} from './local-state.js';

export type AuthStatusReport = {
  ok: boolean;
  cliSessionToken: {
    source: 'config' | 'missing';
    present: boolean;
    maskedValue: string | null;
  };
  apiBaseUrl: {
    source: 'env' | 'config' | 'default';
    present: boolean;
    value: string | null;
  };
  config: {
    path: string;
    exists: boolean;
    accountId: string | null;
    accountName: string | null;
    accountSlug: string | null;
    accountType: 'personal' | 'team' | null;
    sessionExpiresAt: number | null;
    userEmail: string | null;
    userId: string | null;
  };
};

export async function generateAuthStatusReport(): Promise<AuthStatusReport> {
  const [sessionState, apiBaseUrlState, configExists, config] =
    await Promise.all([
      resolveLocalSessionState(),
      resolveApiBaseUrlState(),
      hasLocalConfigFile(),
      readLocalConfig(),
    ]);

  return {
    ok: sessionState.cliSessionToken.present && apiBaseUrlState.present,
    cliSessionToken: {
      source: sessionState.cliSessionToken.source,
      present: sessionState.cliSessionToken.present,
      maskedValue: maskSecret(sessionState.cliSessionToken.value),
    },
    apiBaseUrl: {
      source: apiBaseUrlState.source,
      present: apiBaseUrlState.present,
      value: apiBaseUrlState.value,
    },
    config: {
      path: getPostPlusConfigPath(),
      exists: configExists,
      accountId: config?.accountId?.trim() || null,
      accountName:
        typeof config?.accountName === 'string'
          ? config.accountName.trim() || null
          : null,
      accountSlug:
        typeof config?.accountSlug === 'string'
          ? config.accountSlug.trim() || null
          : null,
      accountType:
        config?.accountType === 'personal' || config?.accountType === 'team'
          ? config.accountType
          : null,
      sessionExpiresAt:
        typeof config?.sessionExpiresAt === 'number'
          ? config.sessionExpiresAt
          : null,
      userEmail:
        typeof config?.userEmail === 'string' ? config.userEmail.trim() : null,
      userId: config?.userId?.trim() || null,
    },
  };
}

export function formatAuthStatusReport(report: AuthStatusReport): string {
  const lines = ['PostPlus CLI auth status', ''];

  lines.push(
    report.cliSessionToken.present
      ? `[PASS] CLI session token: present (${report.cliSessionToken.source})`
      : '[FAIL] CLI session token: missing',
  );
  lines.push(
    report.cliSessionToken.maskedValue
      ? `  Value: ${report.cliSessionToken.maskedValue}`
      : '  Value: not configured',
  );
  lines.push(
    report.apiBaseUrl.present
      ? `[PASS] PostPlus Cloud: configured (${report.apiBaseUrl.source})`
      : '[FAIL] PostPlus Cloud: missing',
  );
  lines.push(
    report.apiBaseUrl.value
      ? `  Value: ${report.apiBaseUrl.value}`
      : '  Value: not configured',
  );
  lines.push(
    report.config.exists
      ? `[PASS] local config: ${report.config.path}`
      : `[PASS] local config path: ${report.config.path}`,
  );
  lines.push(
    ...formatAccountBindingLines({
      accountId: report.config.accountId,
      accountName: report.config.accountName,
      accountSlug: report.config.accountSlug,
      accountType: report.config.accountType,
    }).map((line) => `  ${line}`),
  );
  lines.push(
    `  User: ${report.config.userEmail ?? report.config.userId ?? 'not bound'}`,
  );
  lines.push(
    `  Expires: ${
      report.config.sessionExpiresAt
        ? new Date(report.config.sessionExpiresAt * 1000).toISOString()
        : 'unknown'
    }`,
  );
  lines.push('', report.ok ? 'Auth status OK.' : 'Auth status incomplete.');

  return lines.join('\n');
}

export async function configureApiBaseUrl(
  apiBaseUrl: string,
): Promise<AuthStatusReport> {
  await setLocalApiBaseUrl(apiBaseUrl);
  return generateAuthStatusReport();
}

export async function clearAuthState(): Promise<AuthStatusReport> {
  await clearLocalAuthState();
  return generateAuthStatusReport();
}

export async function prepareAuthState(): Promise<AuthStatusReport> {
  return generateAuthStatusReport();
}
