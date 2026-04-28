import { resolveHostedBaseUrl } from './hosted-release.js';

export type DoctorCheck = {
  id: 'hosted_base_url';
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

export async function generateDoctorReport(): Promise<DoctorReport> {
  const hostedBaseUrl = await resolveHostedBaseUrl();
  const checks: DoctorCheck[] = [
    createPass(
      'hosted_base_url',
      'PostPlus Cloud',
      `Using ${hostedBaseUrl ?? 'https://postplus.io'}`,
    ),
  ];

  return {
    ok: checks.every((check) => check.status === 'pass'),
    checks,
  };
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
