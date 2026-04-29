import {
  type AuthStatusReport,
  formatAuthStatusReport,
  generateAuthStatusReport,
} from './auth.js';
import {
  type DoctorReport,
  formatDoctorReport,
  generateDoctorReport,
} from './doctor.js';

export type StatusReport = {
  ok: boolean;
  doctor: DoctorReport;
  auth: AuthStatusReport;
};

export async function generateStatusReport(): Promise<StatusReport> {
  const [doctor, auth] = await Promise.all([
    generateDoctorReport(),
    generateAuthStatusReport(),
  ]);

  return {
    ok: doctor.ok && auth.ok,
    doctor,
    auth,
  };
}

export function formatStatusReport(report: StatusReport): string {
  return [
    'PostPlus CLI status',
    '',
    `Overall: ${report.ok ? 'OK' : 'INCOMPLETE'}`,
    '',
    formatDoctorReport(report.doctor),
    '',
    formatAuthStatusReport(report.auth),
  ].join('\n');
}
