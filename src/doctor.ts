import { resolveHostedBaseUrl } from './hosted-release.js';
import { resolveAccessTokenState } from './local-state.js';

export type DoctorCheck = {
  id: 'hosted_base_url' | 'hosted_capabilities' | 'remote_auth';
  label: string;
  status: 'pass' | 'fail';
  detail: string;
  fix?: string;
};

export type DoctorReport = {
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
  const accessToken = await resolveAccessTokenState();

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

  if (!accessToken.present || !accessToken.value) {
    checks.push(
      createFail(
        'remote_auth',
        'Remote auth',
        'No PostPlus CLI session is configured.',
        'Run `postplus auth login`.',
      ),
    );
    return buildDoctorReport(checks);
  }

  const authCheck = await checkRemoteAuth({
    accessToken: accessToken.value,
    hostedBaseUrl,
  });
  checks.push(authCheck);

  if (authCheck.status === 'pass') {
    checks.push(
      await checkHostedCapabilities({
        accessToken: accessToken.value,
        hostedBaseUrl,
      }),
    );
  }

  return buildDoctorReport(checks);
}

function buildDoctorReport(checks: DoctorCheck[]): DoctorReport {
  return {
    ok: checks.every((check) => check.status === 'pass'),
    checks,
  };
}

async function checkRemoteAuth(input: {
  accessToken: string;
  hostedBaseUrl: string;
}): Promise<DoctorCheck> {
  try {
    const response = await fetch(
      `${input.hostedBaseUrl}/api/postplus-cli/auth/whoami`,
      {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${input.accessToken}`,
        },
        signal: AbortSignal.timeout(15000),
      },
    );
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

async function checkHostedCapabilities(input: {
  accessToken: string;
  hostedBaseUrl: string;
}): Promise<DoctorCheck> {
  try {
    const response = await fetch(
      `${input.hostedBaseUrl}/api/postplus-cli/hosted/readiness`,
      {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${input.accessToken}`,
        },
        signal: AbortSignal.timeout(15000),
      },
    );
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

  return typeof record.label === 'string'
    ? record.label
    : typeof record.id === 'string'
      ? record.id
      : 'unknown capability';
}

function readErrorMessage(
  payload: { error?: unknown },
  fallback: string,
): string {
  return typeof payload.error === 'string' && payload.error.trim().length > 0
    ? payload.error
    : fallback;
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
