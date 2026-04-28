import { lstat, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  getPostPlusConfigDir,
  readLocalConfig,
  writeLocalConfig,
} from './local-state.js';
import {
  getInstallTargets,
  type PostPlusInstallTargetId,
} from './skills-targets.js';

export type UninstallPlanItem = {
  skillId: string;
  targetId: PostPlusInstallTargetId;
  targetDir: string;
  action: 'remove' | 'already_absent';
};

export type UninstallTargetReport = {
  id: PostPlusInstallTargetId;
  label: string;
  skillsDir: string;
};

export type UninstallReport = {
  ok: boolean;
  mode: 'dry-run' | 'apply';
  removedSkillIds: string[];
  targets: UninstallTargetReport[];
  plan: UninstallPlanItem[];
};

function resolveConfiguredTargets(config: Awaited<ReturnType<typeof readLocalConfig>>): UninstallTargetReport[] {
  const configuredSkillsDirs = {
    ...(config?.installTarget && config?.skillsDir
      ? { [config.installTarget]: config.skillsDir }
      : {}),
    ...(config?.skillsDirs ?? {}),
  };
  const configuredTargets =
    config?.installTargets ??
    (config?.installTarget ? [config.installTarget] : []);
  const targetDefinitions = getInstallTargets();

  return configuredTargets.map((targetId) => {
    const skillsDir = configuredSkillsDirs[targetId]?.trim();

    if (!skillsDir) {
      throw new Error(`Missing skills dir for configured install target: ${targetId}`);
    }

    return {
      id: targetId,
      label:
        targetDefinitions.find((target) => target.id === targetId)?.label ??
        targetId,
      skillsDir,
    };
  });
}

function selectInstalledSkillIds(input: {
  installedSkillIds: string[];
  skillIds?: string[];
}): string[] {
  if (!input.skillIds || input.skillIds.length === 0) {
    return input.installedSkillIds;
  }

  const installedSkillIds = new Set(input.installedSkillIds);
  const unknownSkillIds = input.skillIds.filter(
    (skillId) => !installedSkillIds.has(skillId),
  );

  if (unknownSkillIds.length > 0) {
    throw new Error(`Unknown installed skill ids: ${unknownSkillIds.join(', ')}`);
  }

  return input.skillIds;
}

async function buildPlanItem(input: {
  skillId: string;
  target: UninstallTargetReport;
}): Promise<UninstallPlanItem> {
  const targetDir = resolve(input.target.skillsDir, input.skillId);

  try {
    const stats = await lstat(targetDir);

    if (!stats.isSymbolicLink()) {
      throw new Error(`Tracked skill path is not a symlink: ${targetDir}`);
    }

    return {
      skillId: input.skillId,
      targetId: input.target.id,
      targetDir,
      action: 'remove',
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === 'ENOENT') {
      return {
        skillId: input.skillId,
        targetId: input.target.id,
        targetDir,
        action: 'already_absent',
      };
    }

    throw error;
  }
}

function pruneConfigSkills(input: {
  removedSkillIds: string[];
  config: NonNullable<Awaited<ReturnType<typeof readLocalConfig>>>;
}) {
  const removedSkillIds = new Set(input.removedSkillIds);
  const remainingInstalledSkills = (input.config.installedSkills ?? [])
    .filter((skillId) => !removedSkillIds.has(skillId))
    .sort();
  const installedSkillVersions = Object.fromEntries(
    Object.entries(input.config.installedSkillVersions ?? {}).filter(
      ([skillId]) => !removedSkillIds.has(skillId),
    ),
  );
  const installedSkillIntegrities = Object.fromEntries(
    Object.entries(input.config.installedSkillIntegrities ?? {}).filter(
      ([skillId]) => !removedSkillIds.has(skillId),
    ),
  );
  const nextConfig = { ...input.config };

  if (remainingInstalledSkills.length > 0) {
    nextConfig.installedSkills = remainingInstalledSkills;
  } else {
    delete nextConfig.installTarget;
    delete nextConfig.installTargets;
    delete nextConfig.installedSkills;
    delete nextConfig.skillsDir;
    delete nextConfig.skillsDirs;
  }

  if (Object.keys(installedSkillVersions).length > 0) {
    nextConfig.installedSkillVersions = installedSkillVersions;
  } else {
    delete nextConfig.installedSkillVersions;
  }

  if (Object.keys(installedSkillIntegrities).length > 0) {
    nextConfig.installedSkillIntegrities = installedSkillIntegrities;
  } else {
    delete nextConfig.installedSkillIntegrities;
  }

  return nextConfig;
}

export async function generateUninstallReport(input: {
  skillIds?: string[];
}): Promise<UninstallReport> {
  const config = await readLocalConfig();
  const installedSkillIds = [...(config?.installedSkills ?? [])].sort();
  const removedSkillIds = selectInstalledSkillIds({
    installedSkillIds,
    skillIds: input.skillIds,
  });
  const targets = resolveConfiguredTargets(config);

  if (removedSkillIds.length === 0) {
    return {
      ok: true,
      mode: 'dry-run',
      removedSkillIds: [],
      targets,
      plan: [],
    };
  }

  if (targets.length === 0) {
    throw new Error(
      'No tracked install targets are configured in local CLI state.',
    );
  }

  const plan = await Promise.all(
    targets.flatMap((target) =>
      removedSkillIds.map((skillId) =>
        buildPlanItem({
          skillId,
          target,
        }),
      ),
    ),
  );

  return {
    ok: true,
    mode: 'dry-run',
    removedSkillIds,
    targets,
    plan,
  };
}

export async function applyUninstallReport(
  report: UninstallReport,
): Promise<UninstallReport> {
  for (const item of report.plan) {
    if (item.action !== 'remove') {
      continue;
    }

    await rm(item.targetDir, { recursive: true, force: true });
  }

  for (const skillId of report.removedSkillIds) {
    await rm(resolve(getPostPlusConfigDir(), 'release-bundles', skillId), {
      recursive: true,
      force: true,
    });
  }

  if (report.removedSkillIds.length > 0) {
    const config = await readLocalConfig();

    if (!config) {
      throw new Error(
        'PostPlus local config is missing. Cannot update tracked install state during uninstall.',
      );
    }

    await writeLocalConfig(
      pruneConfigSkills({
        removedSkillIds: report.removedSkillIds,
        config,
      }),
    );
  }

  return {
    ...report,
    mode: 'apply',
  };
}

export function formatUninstallReport(report: UninstallReport): string {
  const lines = [`PostPlus CLI uninstall (${report.mode})`, ''];

  for (const target of report.targets) {
    lines.push(`Target: ${target.id} (${target.label})`);
    lines.push(`Skills dir: ${target.skillsDir}`);
  }

  lines.push('');

  if (report.plan.length === 0) {
    lines.push('No tracked installed skills selected.');
  } else {
    for (const item of report.plan) {
      lines.push(
        `${item.action === 'remove' ? '[REMOVE]' : '[SKIP]'} ${item.skillId} [${item.targetId}]: ${item.targetDir}`,
      );
    }
  }

  lines.push(
    '',
    report.mode === 'dry-run'
      ? 'Uninstall plan ready.'
      : 'Uninstall apply complete.',
  );

  return lines.join('\n');
}
