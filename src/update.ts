import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';

import type { ReleaseManifestMessage } from './postplus-release.js';

import { applyInstallReport, generateInstallReport } from './install.js';
import { readLocalConfig, setLastUpdateCheckAt } from './local-state.js';
import { loadHostedReleaseManifestSource } from './release-source.js';
import type { PostPlusInstallTargetId } from './skills-targets.js';

export type UpdatePlanItem = {
  skillId: string;
  currentVersion: string | null;
  targetVersion: string | null;
  currentIntegrity: string | null;
  targetIntegrity: string;
  reasons: Array<
    'not_installed' | 'version_changed' | 'integrity_changed' | 'missing_target'
  >;
};

export type UpdateReport = {
  ok: boolean;
  canApply: boolean;
  sourceKind: 'hosted-release';
  sourceRef: string;
  messages: ReleaseManifestMessage[];
  skillsDirs: Partial<Record<PostPlusInstallTargetId, string>>;
  updates: UpdatePlanItem[];
  upToDateSkillIds: string[];
  unknownInstalledSkillIds: string[];
};

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function generateUpdateReport(input: {
  skillIds?: string[];
}): Promise<UpdateReport> {
  const [config, manifestSource] = await Promise.all([
    readLocalConfig(),
    loadHostedReleaseManifestSource(),
  ]);
  const manifest = manifestSource.manifest;

  const selectedSkillIds =
    input.skillIds && input.skillIds.length > 0
      ? new Set(input.skillIds)
      : null;
  const installedSkills = config?.installedSkills ?? [];
  const installedSet = new Set(installedSkills);
  const configuredTargets =
    config?.installTargets ??
    (config?.installTarget ? [config.installTarget] : []);
  const configuredSkillsDirs = {
    ...(config?.installTarget && config?.skillsDir
      ? { [config.installTarget]: config.skillsDir }
      : {}),
    ...(config?.skillsDirs ?? {}),
  };
  const unknownInstalledSkillIds = installedSkills.filter(
    (skillId) => !manifest.skills.some((entry) => entry.skillId === skillId),
  );

  const updates: UpdatePlanItem[] = [];
  const upToDateSkillIds: string[] = [];

  for (const entry of manifest.skills) {
    if (selectedSkillIds && !selectedSkillIds.has(entry.skillId)) {
      continue;
    }

    const currentVersion =
      config?.installedSkillVersions?.[entry.skillId] ?? null;
    const currentIntegrity =
      config?.installedSkillIntegrities?.[entry.skillId] ?? null;
    const reasons: UpdatePlanItem['reasons'] = [];

    if (!installedSet.has(entry.skillId)) {
      reasons.push('not_installed');
    }

    if (
      installedSet.has(entry.skillId) &&
      currentVersion !== entry.publishedVersion
    ) {
      reasons.push('version_changed');
    }

    if (
      installedSet.has(entry.skillId) &&
      currentIntegrity !== entry.integrity
    ) {
      reasons.push('integrity_changed');
    }

    if (
      installedSet.has(entry.skillId) &&
      configuredTargets.length > 0 &&
      (await Promise.all(
        configuredTargets.map(async (targetId) => {
          const skillsDir = configuredSkillsDirs[targetId]?.trim();

          if (!skillsDir) {
            return false;
          }

          return pathExists(`${skillsDir}/${entry.skillId}`);
        }),
      )).some((exists) => !exists)
    ) {
      reasons.push('missing_target');
    }

    if (reasons.length > 0) {
      updates.push({
        skillId: entry.skillId,
        currentVersion,
        targetVersion: entry.publishedVersion,
        currentIntegrity,
        targetIntegrity: entry.integrity,
        reasons,
      });
    } else {
      upToDateSkillIds.push(entry.skillId);
    }
  }

  if (selectedSkillIds) {
    const missing = [...selectedSkillIds].filter(
      (skillId) => !manifest.skills.some((entry) => entry.skillId === skillId),
    );
    if (missing.length > 0) {
      throw new Error(`Unknown skill ids: ${missing.join(', ')}`);
    }
  }

  return {
    ok: updates.length === 0 && unknownInstalledSkillIds.length === 0,
    canApply: updates.length > 0,
    messages: manifest.messages ?? [],
    sourceKind: manifestSource.kind,
    sourceRef: manifestSource.baseUrl,
    skillsDirs: configuredSkillsDirs,
    updates,
    upToDateSkillIds,
    unknownInstalledSkillIds,
  };
}

export async function shouldRunAutomaticUpdateCheck(
  now: Date = new Date(),
): Promise<boolean> {
  const config = await readLocalConfig();
  const checkedAt = config?.lastUpdateCheckAt;

  if (!checkedAt) {
    return true;
  }

  const checkedAtMs = Date.parse(checkedAt);

  if (!Number.isFinite(checkedAtMs)) {
    return true;
  }

  return now.getTime() - checkedAtMs >= UPDATE_CHECK_INTERVAL_MS;
}

export async function markUpdateCheckCompleted(now: Date = new Date()) {
  await setLastUpdateCheckAt(now);
}

export function formatUpdateReport(report: UpdateReport): string {
  const lines = ['PostPlus CLI update check', ''];

  const configuredSkillsDirs = Object.entries(report.skillsDirs);
  if (configuredSkillsDirs.length > 0) {
    for (const [targetId, skillsDir] of configuredSkillsDirs) {
      lines.push(`Skills dir (${targetId}): ${skillsDir}`);
    }
    lines.push('');
  }

  lines.push(`Catalog: ${report.sourceRef}`);
  lines.push('');

  if (report.updates.length === 0) {
    lines.push('No local updates required.');
  } else {
    for (const item of report.updates) {
      lines.push(`- ${item.skillId}: ${item.reasons.join(', ')}`);
    }
  }

  if (report.unknownInstalledSkillIds.length > 0) {
    lines.push(
      '',
      `Unknown installed skills: ${report.unknownInstalledSkillIds.join(', ')}`,
    );
  }

  if (report.messages.length > 0) {
    lines.push('', 'PostPlus messages:');

    for (const message of report.messages) {
      const label = message.title ?? message.kind;
      lines.push(`- ${label}: ${message.body}`);

      if (message.ctaLabel || message.ctaUrl) {
        lines.push(
          `  ${[message.ctaLabel, message.ctaUrl].filter(Boolean).join(' ')}`,
        );
      }
    }
  }

  return lines.join('\n');
}

export type UpdateNotice = {
  updateCount: number;
  message: string;
  command: string;
  serverMessages: Array<{ title: string; body: string; ctaLabel?: string | null; ctaUrl?: string | null }>;
};

export async function collectUpdateNotice(): Promise<UpdateNotice | null> {
  if (!(await shouldRunAutomaticUpdateCheck())) {
    return null;
  }

  try {
    const report = await generateUpdateReport({});
    await markUpdateCheckCompleted();

    if (report.updates.length === 0 && report.messages.length === 0) {
      return null;
    }

    return {
      updateCount: report.updates.length,
      message:
        report.updates.length > 0
          ? `${report.updates.length} skill update(s) available.`
          : '',
      command: 'postplus update --apply',
      serverMessages: report.messages.map((m) => ({
        title: m.title ?? m.kind,
        body: m.body,
        ctaLabel: m.ctaLabel,
        ctaUrl: m.ctaUrl,
      })),
    };
  } catch {
    return null;
  }
}

export async function applyUpdateReport(input: {
  report: UpdateReport;
  force?: boolean;
}) {
  if (!input.report.canApply) {
    return input.report;
  }

  const installReport = await generateInstallReport({
    skillIds: input.report.updates.map((item) => item.skillId),
    force: input.force === true,
  });
  await applyInstallReport(installReport);
  return generateUpdateReport({});
}
