import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import {
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import type {
  ReleaseManifestSkill,
  ReleaseSkillBundle,
  ReleaseSkillBundleFile,
} from './postplus-release.js';

import {
  getHostedReleaseSkillUrl,
  loadHostedReleaseSkillBundle,
} from './hosted-release.js';
import {
  getPostPlusConfigDir,
  readLocalConfig,
  writeLocalConfig,
} from './local-state.js';
import { loadHostedReleaseManifestSource } from './release-source.js';
import {
  getInstallTargets,
  type PostPlusInstallTarget,
  type PostPlusInstallTargetId,
} from './skills-targets.js';

export type InstallPlanItem = {
  skillId: string;
  publishedVersion: string | null;
  integrity: string;
  sourceKind: 'hosted-release';
  sourceRef: string;
  targetId: PostPlusInstallTargetId;
  targetDir: string;
  action: 'install' | 'already_installed' | 'replace';
};

export type InstallTargetReport = {
  id: PostPlusInstallTargetId;
  label: string;
  skillsDir: string;
};

export type InstallReport = {
  ok: boolean;
  mode: 'dry-run' | 'apply';
  sourceKind: 'hosted-release';
  sourceRef: string;
  targets: InstallTargetReport[];
  installedSkillIds: string[];
  plan: InstallPlanItem[];
};

export type InstallTargetStatus = {
  id: PostPlusInstallTargetId;
  label: string;
  skillsDir: string | null;
  ok: boolean;
  missingTargets: string[];
};

export type InstallStatusReport = {
  ok: boolean;
  targets: InstallTargetStatus[];
  installedSkills: string[];
};

async function pathExists(pathname: string): Promise<boolean> {
  try {
    lstatSync(pathname);
    return true;
  } catch {
    return false;
  }
}

async function removePathIfPresent(pathname: string): Promise<void> {
  await rm(pathname, { recursive: true, force: true });
}

function createTemporarySiblingPath(
  targetPath: string,
  label: 'staging' | 'backup',
): string {
  return resolve(
    dirname(targetPath),
    `.${basename(targetPath)}.postplus-${label}-${randomUUID()}`,
  );
}

async function replaceTargetAtomically(input: {
  targetPath: string;
  prepareReplacement: (stagingPath: string) => Promise<void>;
}): Promise<void> {
  const stagingPath = createTemporarySiblingPath(input.targetPath, 'staging');
  const backupPath = createTemporarySiblingPath(input.targetPath, 'backup');
  let targetMovedToBackup = false;

  try {
    await input.prepareReplacement(stagingPath);

    if (await pathExists(input.targetPath)) {
      await rename(input.targetPath, backupPath);
      targetMovedToBackup = true;
    }

    await rename(stagingPath, input.targetPath);

    if (targetMovedToBackup) {
      await removePathIfPresent(backupPath);
    }
  } catch (error) {
    await removePathIfPresent(stagingPath);

    if (targetMovedToBackup) {
      const [backupExists, targetExists] = await Promise.all([
        pathExists(backupPath),
        pathExists(input.targetPath),
      ]);

      if (backupExists && !targetExists) {
        await rename(backupPath, input.targetPath);
      } else if (backupExists) {
        await removePathIfPresent(backupPath);
      }
    }

    throw error;
  }
}

async function buildPlanItem(input: {
  entry: ReleaseManifestSkill;
  sourceKind: 'hosted-release';
  sourceRef: string;
  expectedInstalledDir?: string;
  targetId: PostPlusInstallTargetId;
  skillsDir: string;
  force: boolean;
}): Promise<InstallPlanItem> {
  const targetDir = resolve(input.skillsDir, input.entry.skillId);

  if (!(await pathExists(targetDir))) {
    return {
      skillId: input.entry.skillId,
      publishedVersion: input.entry.publishedVersion,
      integrity: input.entry.integrity,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      targetId: input.targetId,
      targetDir,
      action: 'install',
    };
  }

  const targetStats = lstatSync(targetDir);
  if (targetStats.isSymbolicLink() && input.expectedInstalledDir) {
    const expectedPathExists = await pathExists(input.expectedInstalledDir);

    if (!expectedPathExists) {
      return {
        skillId: input.entry.skillId,
        publishedVersion: input.entry.publishedVersion,
        integrity: input.entry.integrity,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        targetId: input.targetId,
        targetDir,
        action: 'replace',
      };
    }

    const [currentRealPath, expectedRealPath] = await Promise.all([
      realpath(targetDir),
      realpath(input.expectedInstalledDir),
    ]);

    if (currentRealPath === expectedRealPath) {
      return {
        skillId: input.entry.skillId,
        publishedVersion: input.entry.publishedVersion,
        integrity: input.entry.integrity,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        targetId: input.targetId,
        targetDir,
        action: 'already_installed',
      };
    }
  }

  if (!input.force) {
    throw new Error(
      `Target skill path already exists and does not match the released bundle source: ${targetDir}`,
    );
  }

  return {
    skillId: input.entry.skillId,
    publishedVersion: input.entry.publishedVersion,
    integrity: input.entry.integrity,
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
    targetId: input.targetId,
    targetDir,
    action: 'replace',
  };
}

function toInstallTargetReport(
  target: PostPlusInstallTarget,
): InstallTargetReport {
  return {
    id: target.id,
    label: target.label,
    skillsDir: target.skillsDir,
  };
}

function getConfiguredTarget(
  targets: InstallTargetReport[],
  targetId: PostPlusInstallTargetId,
): InstallTargetReport {
  const target = targets.find((entry) => entry.id === targetId);

  if (!target) {
    throw new Error(`Unknown install target: ${targetId}`);
  }

  return target;
}

function selectManifestEntries<T extends { skillId: string }>(
  entries: T[],
  skillIds?: string[],
): T[] {
  const selectedSkillIds =
    skillIds && skillIds.length > 0 ? new Set(skillIds) : null;
  const selectedEntries = selectedSkillIds
    ? entries.filter((entry) => selectedSkillIds.has(entry.skillId))
    : entries;

  if (selectedSkillIds) {
    const missing = [...selectedSkillIds].filter(
      (skillId) => !selectedEntries.some((entry) => entry.skillId === skillId),
    );
    if (missing.length > 0) {
      throw new Error(`Unknown skill ids: ${missing.join(', ')}`);
    }
  }

  return selectedEntries;
}

async function writeHostedBundleFile(
  bundleRoot: string,
  file: ReleaseSkillBundleFile,
): Promise<void> {
  const targetPath = resolve(bundleRoot, file.path);
  const targetPrefix = `${bundleRoot}${process.platform === 'win32' ? '\\' : '/'}`;

  if (targetPath !== bundleRoot && !targetPath.startsWith(targetPrefix)) {
    throw new Error(`Invalid hosted bundle file path: ${file.path}`);
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(file.contentBase64, 'base64'));
}

function normalizeIntegrityForPath(integrity: string): string {
  return integrity.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function getHostedBundleRootDir(input: {
  integrity: string;
  skillId: string;
}): string {
  return resolve(
    getPostPlusConfigDir(),
    'release-bundles',
    input.skillId,
    normalizeIntegrityForPath(input.integrity),
  );
}

function getHostedInstalledSkillDir(input: {
  integrity: string;
  skillId: string;
}): string {
  return resolve(getHostedBundleRootDir(input), 'skills', input.skillId);
}

async function ensureHostedBundleReady(
  bundle: ReleaseSkillBundle,
): Promise<string> {
  const bundleRoot = getHostedBundleRootDir({
    integrity: bundle.integrity,
    skillId: bundle.skillId,
  });
  const installedSkillDir = resolve(bundleRoot, 'skills', bundle.skillId);

  if (await pathExists(installedSkillDir)) {
    return bundleRoot;
  }

  await replaceTargetAtomically({
    targetPath: bundleRoot,
    prepareReplacement: async (stagingPath) => {
      await mkdir(stagingPath, { recursive: true });

      for (const file of bundle.files) {
        await writeHostedBundleFile(stagingPath, file);
      }
    },
  });

  return bundleRoot;
}

export async function generateInstallReport(input: {
  skillIds?: string[];
  force?: boolean;
}): Promise<InstallReport> {
  const targets = getInstallTargets().map(toInstallTargetReport);
  const manifestSource = await loadHostedReleaseManifestSource();

  const selectedEntries = selectManifestEntries(
    manifestSource.manifest.skills,
    input.skillIds,
  );
  const plan = await Promise.all(
    targets.flatMap((target) =>
      selectedEntries.map((entry) =>
        buildPlanItem({
          entry,
          sourceKind: 'hosted-release',
          sourceRef: getHostedReleaseSkillUrl(
            manifestSource.baseUrl,
            entry.skillId,
          ),
          expectedInstalledDir: getHostedInstalledSkillDir({
            integrity: entry.integrity,
            skillId: entry.skillId,
          }),
          targetId: target.id,
          skillsDir: target.skillsDir,
          force: input.force === true,
        }),
      ),
    ),
  );

  return {
    ok: true,
    mode: 'dry-run',
    sourceKind: 'hosted-release',
    sourceRef: manifestSource.baseUrl,
    targets,
    installedSkillIds: selectedEntries.map((item) => item.skillId),
    plan,
  };
}

export async function applyInstallReport(
  report: InstallReport,
): Promise<InstallReport> {
  await Promise.all(
    report.targets.map((target) => mkdir(target.skillsDir, { recursive: true })),
  );

  for (const item of report.plan) {
    if (item.action === 'already_installed') {
      continue;
    }

    getConfiguredTarget(report.targets, item.targetId);

    const bundle = await loadHostedReleaseSkillBundle(
      report.sourceRef,
      item.skillId,
    );

    if (bundle.integrity !== item.integrity) {
      throw new Error(
        `Hosted bundle integrity mismatch for ${item.skillId}: expected ${item.integrity}, received ${bundle.integrity}`,
      );
    }

    await replaceTargetAtomically({
      targetPath: item.targetDir,
      prepareReplacement: async (stagingPath) => {
        const bundleRoot = await ensureHostedBundleReady(bundle);
        const installedSkillDir = resolve(bundleRoot, 'skills', item.skillId);

        await symlink(
          installedSkillDir,
          stagingPath,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
    });
  }

  const currentConfig = (await readLocalConfig()) ?? {};
  const installedSkills = new Set(currentConfig.installedSkills ?? []);

  for (const skillId of report.installedSkillIds) {
    installedSkills.add(skillId);
  }

  await writeLocalConfig({
    ...currentConfig,
    installTargets: report.targets.map((target) => target.id),
    installedSkills: [...installedSkills].sort(),
    installedSkillVersions: {
      ...(currentConfig.installedSkillVersions ?? {}),
      ...Object.fromEntries(
        report.plan.map((item) => [item.skillId, item.publishedVersion]),
      ),
    },
    installedSkillIntegrities: {
      ...(currentConfig.installedSkillIntegrities ?? {}),
      ...Object.fromEntries(
        report.plan.map((item) => [item.skillId, item.integrity]),
      ),
    },
    skillsDirs: Object.fromEntries(
      report.targets.map((target) => [target.id, target.skillsDir]),
    ),
  });

  return {
    ...report,
    mode: 'apply',
  };
}

export function formatInstallReport(report: InstallReport): string {
  const lines = [
    `PostPlus CLI install (${report.mode})`,
    '',
    `Catalog: ${report.sourceRef}`,
  ];

  for (const target of report.targets) {
    lines.push(`Target: ${target.id} (${target.label})`);
    lines.push(`Skills dir: ${target.skillsDir}`);
  }

  lines.push('');

  for (const item of report.plan) {
    const marker =
      item.action === 'already_installed'
        ? '[SKIP]'
        : item.action === 'replace'
          ? '[REPLACE]'
          : '[INSTALL]';
    lines.push(
      `${marker} ${item.skillId} [${item.targetId}]: ${item.targetDir} <- ${item.sourceRef}`,
    );
  }

  lines.push(
    '',
    report.mode === 'dry-run'
      ? 'Install plan ready.'
      : 'Install apply complete.',
  );

  return lines.join('\n');
}

export async function generateInstallStatusReport(): Promise<InstallStatusReport> {
  const config = await readLocalConfig();
  const installedSkills = [...(config?.installedSkills ?? [])].sort();
  const targetDefinitions = getInstallTargets();
  const configuredSkillsDirs = {
    ...(config?.installTarget && config?.skillsDir
      ? { [config.installTarget]: config.skillsDir }
      : {}),
    ...(config?.skillsDirs ?? {}),
  };
  const installTargets =
    config?.installTargets ??
    (config?.installTarget ? [config.installTarget] : []);
  const targets = await Promise.all(
    installTargets.map(async (targetId) => {
      const skillsDir = configuredSkillsDirs[targetId]?.trim() || null;
      const missingTargets =
        skillsDir && installedSkills.length > 0
          ? await Promise.all(
              installedSkills.map(async (skillId) =>
                (await pathExists(resolve(skillsDir, skillId))) ? null : skillId,
              ),
            ).then((values) =>
              values.filter((value): value is string => Boolean(value)),
            )
          : [];

      return {
        id: targetId,
        label:
          targetDefinitions.find((target) => target.id === targetId)?.label ??
          targetId,
        skillsDir,
        ok:
          Boolean(skillsDir) &&
          installedSkills.length > 0 &&
          missingTargets.length === 0,
        missingTargets,
      } satisfies InstallTargetStatus;
    }),
  );

  return {
    ok: targets.length > 0 && targets.every((target) => target.ok),
    targets,
    installedSkills,
  };
}

export function formatInstallStatusReport(report: InstallStatusReport): string {
  const lines = ['PostPlus CLI install status', ''];

  if (report.targets.length === 0) {
    lines.push('[FAIL] install targets: not configured');
  } else {
    for (const target of report.targets) {
      lines.push(
        target.ok
          ? `[PASS] ${target.id} skills dir: ${target.skillsDir}`
          : `[FAIL] ${target.id} skills dir: ${target.skillsDir ?? 'not configured'}`,
      );

      if (target.missingTargets.length > 0) {
        lines.push(
          `[FAIL] ${target.id} missing targets: ${target.missingTargets.join(', ')}`,
        );
      }
    }
  }

  lines.push(
    report.installedSkills.length > 0
      ? `[PASS] installed skills: ${report.installedSkills.join(', ')}`
      : '[FAIL] installed skills: none recorded',
  );

  lines.push(
    '',
    report.ok ? 'Install status OK.' : 'Install status incomplete.',
  );

  return lines.join('\n');
}
