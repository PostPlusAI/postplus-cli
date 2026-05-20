import {
  type AuthStatusReport,
  formatAuthStatusReport,
  generateAuthStatusReport,
} from './auth.js';
import { writeCurrentCliVersionToLocalConfig } from './client-compatibility.js';
import {
  type DoctorReport,
  formatDoctorReport,
  generateDoctorReport,
} from './doctor.js';
import {
  type SkillInstallStatusReport,
  formatSkillInstallStatusReport,
  generateSkillInstallStatusReport,
} from './skill-management.js';
import {
  type UpdateStatusReport,
  formatUpdateStatusReport,
  generateUpdateStatusReport,
} from './update-check.js';

export type StatusReport = {
  schemaVersion: 1;
  ok: boolean;
  doctor: DoctorReport;
  auth: AuthStatusReport;
  skills: SkillInstallStatusReport;
  updates: UpdateStatusReport;
  skillId?: string;
};

export type StatusReportOptions = {
  skillId?: string;
};

export async function generateStatusReport(
  options: StatusReportOptions = {},
): Promise<StatusReport> {
  return generateStatusReportWithDependencies({}, options);
}

export async function generateStatusReportWithDependencies(
  dependencies: {
    generateAuthStatus?: typeof generateAuthStatusReport;
    generateDoctor?: typeof generateDoctorReport;
    generateSkillStatus?: typeof generateSkillInstallStatusReport;
    generateUpdateStatus?: typeof generateUpdateStatusReport;
  } = {},
  options: StatusReportOptions = {},
): Promise<StatusReport> {
  await writeCurrentCliVersionToLocalConfig();

  const generateAuthStatus =
    dependencies.generateAuthStatus ?? generateAuthStatusReport;
  const generateDoctor = dependencies.generateDoctor ?? generateDoctorReport;
  const generateSkillStatus =
    dependencies.generateSkillStatus ??
    (() =>
      generateSkillInstallStatusReport(undefined, {
        repairManagedBaseline: true,
      }));
  const generateUpdateStatus =
    dependencies.generateUpdateStatus ?? generateUpdateStatusReport;

  const skills = await generateSkillStatus();
  const [doctor, auth, updates] = await Promise.all([
    generateDoctor({ skillId: options.skillId }),
    generateAuthStatus(),
    generateUpdateStatus(),
  ]);

  return {
    schemaVersion: 1,
    ok: doctor.requiredOk && auth.ok && skills.ok && updates.ok,
    doctor,
    auth,
    skills,
    updates,
    ...(options.skillId ? { skillId: options.skillId } : {}),
  };
}

export function formatStatusReport(report: StatusReport): string {
  const taskSpecificChecksNeedAttention =
    report.doctor.requiredOk && !report.doctor.ok;

  return [
    'PostPlus CLI status',
    '',
    `Overall: ${
      report.ok
        ? taskSpecificChecksNeedAttention
          ? 'OK (task-specific checks need attention)'
          : 'OK'
        : 'INCOMPLETE'
    }`,
    '',
    formatDoctorReport(report.doctor),
    '',
    formatAuthStatusReport(report.auth),
    '',
    formatSkillInstallStatusReport(report.skills),
    '',
    formatUpdateStatusReport(report.updates),
  ].join('\n');
}
