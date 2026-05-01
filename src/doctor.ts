import {
  type FreshRemoteAuth,
  resolveFreshRemoteAuth,
} from './auth-session.js';
import { resolveHostedBaseUrl } from './hosted-release.js';
import {
  formatLocalDependencyReport,
  generateLocalDependencyReport,
} from './local-dependencies.js';

export type DoctorCheck = {
  id:
    | 'hosted_base_url'
    | 'hosted_capabilities'
    | 'local_dependencies'
    | 'remote_auth';
  label: string;
  status: 'pass' | 'fail';
  detail: string;
  fix?: string;
};

export type DoctorReport = {
  schemaVersion: 1;
  ok: boolean;
  checks: DoctorCheck[];
};

function createPass(
  id: DoctorCheck['id'],
  label: string,
  detail: string,
): DoctorCheck {
  return {
    id,
    label,
    status: 'pass',
    detail,
  };
}

function createFail(
  id: DoctorCheck['id'],
  label: string,
  detail: string,
  fix?: string,
): DoctorCheck {
  return {
    id,
    label,
    status: 'fail',
    detail,
    fix,
  };
}

export async function generateDoctorReport(): Promise<DoctorReport> {
  const hostedBaseUrl = await resolveHostedBaseUrl();
  const checks: DoctorCheck[] = [
    createPass(
      'hosted_base_url',
      'PostPlus Cloud',
      `Using ${hostedBaseUrl ?? 'https://postplus.io'}`,
    ),
  ];
  checks.push(await checkLocalDependencies());

  if (!hostedBaseUrl) {
    checks.push(
      createFail(
        'remote_auth',
        'Remote auth',
        'PostPlus Cloud base URL could not be resolved.',
        'Configure POSTPLUS_API_BASE_URL or run `postplus auth login`.',
      ),
    );
    return buildDoctorReport(checks);
  }

  const auth = await resolveFreshRemoteAuth().catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : 'No PostPlus CLI session is configured.';

    checks.push(
      createFail(
        'remote_auth',
        'Remote auth',
        message,
        'Run `postplus auth login`.',
      ),
    );

    return null;
  });

  if (!auth) {
    return buildDoctorReport(checks);
  }

  const authCheck = await checkRemoteAuth(auth);
  checks.push(authCheck);

  if (authCheck.status === 'pass') {
    checks.push(await checkHostedCapabilities(auth));
  }

  return buildDoctorReport(checks);
}

async function checkLocalDependencies(): Promise<DoctorCheck> {
  try {
    const report = await generateLocalDependencyReport();
    const detail = formatLocalDependencyReport(report);

    if (!report.ok) {
      return createFail(
        'local_dependencies',
        'Local dependencies',
        detail,
        'Install the missing host binaries or Python modules, then rerun `postplus doctor`.',
      );
    }

    return createPass('local_dependencies', 'Local dependencies', detail);
  } catch (error) {
    return createFail(
      'local_dependencies',
      'Local dependencies',
      error instanceof Error
        ? error.message
        : 'Failed to check local dependencies.',
    );
  }
}

function buildDoctorReport(checks: DoctorCheck[]): DoctorReport {
  return {
    schemaVersion: 1,
    ok: checks.every((check) => check.status === 'pass'),
    checks,
  };
}

async function checkRemoteAuth(input: FreshRemoteAuth): Promise<DoctorCheck> {
  try {
    let response = await requestWithAuth(
      input,
      '/api/postplus-cli/auth/whoami',
    );

    if (response.status === 401) {
      const refreshedAuth = await resolveFreshRemoteAuth({
        forceRefresh: true,
      });
      response = await requestWithAuth(
        refreshedAuth,
        '/api/postplus-cli/auth/whoami',
      );
    }

    const payload = (await response.json()) as {
      accountId?: unknown;
      error?: unknown;
      subscriptionStatus?: unknown;
      userEmail?: unknown;
      userId?: unknown;
    };

    if (!response.ok) {
      return createFail(
        'remote_auth',
        'Remote auth',
        readErrorMessage(payload, 'PostPlus Cloud rejected the CLI session.'),
        'Run `postplus auth login`.',
      );
    }

    const accountId =
      typeof payload.accountId === 'string' ? payload.accountId : 'unknown';
    const user =
      typeof payload.userEmail === 'string'
        ? payload.userEmail
        : typeof payload.userId === 'string'
          ? payload.userId
          : 'unknown';
    const subscription =
      typeof payload.subscriptionStatus === 'string'
        ? payload.subscriptionStatus
        : 'unknown';

    return createPass(
      'remote_auth',
      'Remote auth',
      `Account ${accountId}; user ${user}; subscription ${subscription}`,
    );
  } catch (error) {
    return createFail(
      'remote_auth',
      'Remote auth',
      error instanceof Error
        ? error.message
        : 'Failed to validate PostPlus Cloud auth.',
      'Run `postplus auth validate` after confirming network access.',
    );
  }
}

async function checkHostedCapabilities(
  input: FreshRemoteAuth,
): Promise<DoctorCheck> {
  try {
    let response = await requestWithAuth(
      input,
      '/api/postplus-cli/hosted/readiness',
    );

    if (response.status === 401) {
      const refreshedAuth = await resolveFreshRemoteAuth({
        forceRefresh: true,
      });
      response = await requestWithAuth(
        refreshedAuth,
        '/api/postplus-cli/hosted/readiness',
      );
    }

    const payload = (await response.json()) as {
      capabilities?: unknown;
      error?: unknown;
      ok?: unknown;
      subscriptionActive?: unknown;
      subscriptionStatus?: unknown;
    };

    if (!response.ok) {
      return createFail(
        'hosted_capabilities',
        'Hosted capabilities',
        readErrorMessage(
          payload,
          'PostPlus Cloud hosted readiness check failed.',
        ),
      );
    }

    const capabilities = Array.isArray(payload.capabilities)
      ? payload.capabilities
      : [];
    const failedLabels = capabilities
      .map(readCapabilityFailureLabel)
      .filter((value): value is string => value !== null);

    if (payload.ok !== true || failedLabels.length > 0) {
      return createFail(
        'hosted_capabilities',
        'Hosted capabilities',
        `Not ready: ${failedLabels.join(', ') || 'unknown capability failure'}`,
        'Check PostPlus Cloud provider configuration and subscription state.',
      );
    }

    const subscription =
      typeof payload.subscriptionStatus === 'string'
        ? payload.subscriptionStatus
        : 'unknown';

    return createPass(
      'hosted_capabilities',
      'Hosted capabilities',
      `Ready (${capabilities.length} capability checks passed; subscription ${subscription})`,
    );
  } catch (error) {
    return createFail(
      'hosted_capabilities',
      'Hosted capabilities',
      error instanceof Error
        ? error.message
        : 'Failed to check hosted capability readiness.',
    );
  }
}

function readCapabilityFailureLabel(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return 'invalid capability response';
  }

  const record = value as Record<string, unknown>;
  if (record.ok === true || record.required === false) {
    return null;
  }

  const label =
    typeof record.label === 'string'
      ? record.label
      : typeof record.id === 'string'
        ? record.id
        : 'unknown capability';
  const failedChecks = Array.isArray(record.checks)
    ? record.checks
        .map(readReadinessCheckFailureLabel)
        .filter((check): check is string => check !== null)
    : [];

  return failedChecks.length > 0
    ? `${label} (${failedChecks.join(', ')})`
    : label;
}

function readReadinessCheckFailureLabel(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return 'invalid readiness check';
  }

  const record = value as Record<string, unknown>;
  if (record.ok === true || record.required === false) {
    return null;
  }

  return typeof record.label === 'string'
    ? record.label
    : typeof record.id === 'string'
      ? record.id
      : 'unknown check';
}

function readErrorMessage(
  payload: { error?: unknown },
  fallback: string,
): string {
  return typeof payload.error === 'string' && payload.error.trim().length > 0
    ? payload.error
    : fallback;
}

function requestWithAuth(input: FreshRemoteAuth, path: string) {
  return fetch(`${input.apiBaseUrl}${path}`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${input.accessToken}`,
    },
    signal: AbortSignal.timeout(15000),
  });
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['PostPlus CLI doctor', ''];

  for (const check of report.checks) {
    const marker = check.status === 'pass' ? '[PASS]' : '[FAIL]';
    lines.push(`${marker} ${check.label}: ${check.detail}`);
    if (check.fix) {
      lines.push(`  Fix: ${check.fix}`);
    }
  }

  lines.push('', report.ok ? 'Doctor passed.' : 'Doctor failed.');

  return lines.join('\n');
}
