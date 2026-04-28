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
import {
  type InstallStatusReport,
  formatInstallStatusReport,
  generateInstallStatusReport,
} from './install.js';
import {
  type UpdateReport,
  formatUpdateReport,
  generateUpdateReport,
  markUpdateCheckCompleted,
} from './update.js';

export type StatusReport = {
  ok: boolean;
  doctor: DoctorReport;
  auth: AuthStatusReport;
  install: InstallStatusReport;
  update: UpdateReport;
};

export async function generateStatusReport(): Promise<StatusReport> {
  const [doctor, auth, install, update] = await Promise.all([
    generateDoctorReport(),
    generateAuthStatusReport(),
    generateInstallStatusReport(),
    generateUpdateReport({}),
  ]);
  await markUpdateCheckCompleted();

  return {
    ok:
      doctor.ok &&
      auth.ok &&
      install.ok &&
      isBlockingUpdateStateAbsent(update),
    doctor,
    auth,
    install,
    update,
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
    '',
    formatInstallStatusReport(report.install),
    '',
    formatUpdateReport(report.update),
  ].join('\n');
}

function isBlockingUpdateStateAbsent(report: UpdateReport) {
  if (report.unknownInstalledSkillIds.length > 0) {
    return false;
  }

  return report.updates.every((item) =>
    item.reasons.every((reason) => reason === 'not_installed'),
  );
}
