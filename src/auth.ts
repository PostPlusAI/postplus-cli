import {
  clearLocalAuthState,
  getPostPlusConfigPath,
  hasLocalConfigFile,
  maskSecret,
  readLocalConfig,
  resolveApiBaseUrlState,
  resolveLocalSessionState,
  setLocalAccessToken,
  setLocalApiBaseUrl,
  setLocalRefreshToken,
} from './local-state.js';

export type AuthStatusReport = {
  ok: boolean;
  accessToken: {
    source: 'env' | 'config' | 'missing';
    present: boolean;
    maskedValue: string | null;
  };
  refreshToken: {
    source: 'env' | 'config' | 'missing';
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
    userEmail: string | null;
    userId: string | null;
  };
  sessionExpiresAt: number | null;
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
    ok:
      sessionState.accessToken.present &&
      sessionState.refreshToken.present &&
      apiBaseUrlState.present,
    accessToken: {
      source: sessionState.accessToken.source,
      present: sessionState.accessToken.present,
      maskedValue: maskSecret(sessionState.accessToken.value),
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
      userEmail:
        typeof config?.userEmail === 'string' ? config.userEmail.trim() : null,
      userId: config?.userId?.trim() || null,
    },
    refreshToken: {
      source: sessionState.refreshToken.source,
      present: sessionState.refreshToken.present,
      maskedValue: maskSecret(sessionState.refreshToken.value),
    },
    sessionExpiresAt: sessionState.expiresAt,
  };
}

export function formatAuthStatusReport(report: AuthStatusReport): string {
  const lines = ['PostPlus CLI auth status', ''];

  lines.push(
    report.accessToken.present
      ? `[PASS] Access token: present (${report.accessToken.source})`
      : '[FAIL] Access token: missing',
  );
  lines.push(
    report.accessToken.maskedValue
      ? `  Value: ${report.accessToken.maskedValue}`
      : '  Value: not configured',
  );
  lines.push(
    report.refreshToken.present
      ? `[PASS] Refresh token: present (${report.refreshToken.source})`
      : '[FAIL] Refresh token: missing',
  );
  lines.push(
    report.refreshToken.maskedValue
      ? `  Value: ${report.refreshToken.maskedValue}`
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
  lines.push(`  Account: ${report.config.accountId ?? 'not bound'}`);
  lines.push(
    `  User: ${report.config.userEmail ?? report.config.userId ?? 'not bound'}`,
  );
  lines.push(
    `  Session expires at: ${
      typeof report.sessionExpiresAt === 'number'
        ? new Date(report.sessionExpiresAt * 1000).toISOString()
        : 'unknown'
    }`,
  );
  lines.push('', report.ok ? 'Auth status OK.' : 'Auth status incomplete.');

  return lines.join('\n');
}

export async function configureAccessToken(
  accessToken: string,
): Promise<AuthStatusReport> {
  await setLocalAccessToken(accessToken);
  return generateAuthStatusReport();
}

export async function configureRefreshToken(
  refreshToken: string,
): Promise<AuthStatusReport> {
  await setLocalRefreshToken(refreshToken);
  return generateAuthStatusReport();
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
