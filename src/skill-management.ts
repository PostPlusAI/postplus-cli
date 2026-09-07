import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { writeCurrentCliVersionToLocalConfig } from './client-compatibility.js';
import { runCommand, runInteractiveCommand } from './command-runner.js';
import {
  clearManagedSkillBaseline,
  getPostPlusConfigDir,
  readManagedSkillBaseline,
  withPostPlusUpdateLock,
  writeManagedSkillBaseline,
} from './local-state.js';
import {
  POSTPLUS_SKILLS_AGENT_TARGETS,
  type PostPlusSkillsInstallScope,
  formatPostPlusSkillsInstallCommand,
  loadPublicSkillCatalog,
  resolvePostPlusSkillsSource,
} from './skill-catalog.js';
import { clearUpdateCheckCache } from './update-check.js';
import {
  assertPostPlusSkillsBaselineWritable,
  readPostPlusInstallerLockedSkillEntries,
  resolvePostPlusSkillsScope,
} from './skill-installation.js';

const NPX_SKILLS = ['-y', 'skills'];

export type InstalledSkillEntry = {
  agents: string[];
  name: string;
  path: string;
  scope: 'global' | 'project' | string;
};

export type SkillInstallStatusReport = {
  ok: boolean;
  installedCount: number;
  missingSkills: string[];
  requiredCount: number;
  scopes: string[];
  source: string;
  error: string | null;
  installCommand: string;
  managedSkillsReleaseId: string | null;
  updateCommand: string;
  uninstallCommand: string;
  retiredManagedSkills: string[];
};

export type SkillBaselineVerifyReport = SkillInstallStatusReport & {
  baselineUpdated: boolean;
  previousManagedSkillsReleaseId: string | null;
  verifiedSkillsReleaseId: string | null;
};

type SkillManagementDependencies = {
  runCommand: typeof runCommand;
};

type SkillMutationDependencies = {
  confirmModifiedSkillBackup?: (
    input: ModifiedSkillBackupPrompt,
  ) => Promise<boolean>;
  isInteractive?: () => boolean;
  reportSuccess?: (message: string) => void;
  runCommand: typeof runCommand;
  runInteractiveCommand: typeof runInteractiveCommand;
};

type SkillMutationOptions = {
  messageMode?: 'explicit' | 'implicit';
  scope: PostPlusSkillsInstallScope;
};

type ModifiedSkillBackupPrompt = {
  action: 'uninstall' | 'update';
  scope: PostPlusSkillsInstallScope;
  skillNames: string[];
};

type ModifiedInstalledSkill = {
  actualContentHash: string;
  expectedContentHash: string;
  installedPath: string;
  name: string;
};

const DEFAULT_SKILL_MUTATION_OPTIONS: SkillMutationOptions = {
  scope: 'global',
};

async function withPostPlusSkillsMutationLock<T>(
  scope: PostPlusSkillsInstallScope,
  operation: () => Promise<T>,
): Promise<T> {
  // Config, profile and installer state overrides do not change this scope.
  const installationRoot = await realpath(
    scope === 'global' ? homedir() : process.cwd(),
  );
  return withPostPlusUpdateLock(operation, {
    installationRoot,
    lockName: '.postplus-skills-update.lock',
  });
}

export async function runPostPlusSkillUpdate(
  dependencies: SkillMutationDependencies = {
    confirmModifiedSkillBackup: confirmModifiedSkillBackup,
    isInteractive: () => process.stdin.isTTY === true,
    reportSuccess: (message) => process.stdout.write(`${message}\n`),
    runCommand,
    runInteractiveCommand,
  },
  options?: SkillMutationOptions,
): Promise<number> {
  options ??= { scope: await resolvePostPlusSkillsScope() };
  const resolvedOptions = options;
  return withPostPlusSkillsMutationLock(options.scope, () =>
    reconcilePostPlusSkills(dependencies, resolvedOptions),
  );
}

async function reconcilePostPlusSkills(
  dependencies: SkillMutationDependencies,
  options: SkillMutationOptions,
): Promise<number> {
  const catalog = await loadPublicSkillCatalog();
  const skillNames = catalog.skills.map((skill) => skill.skillId);
  const releasedSkills = new Set(skillNames);
  const baseline = await readManagedSkillBaseline(options.scope);
  const lockedSkillNames = await readPostPlusInstallerLockedSkillEntries(
    options.scope,
  ).then((entries) => entries.map((entry) => entry.name));
  const retiredSkillNames = mergeSkillNames(
    baseline.skillNames,
    lockedSkillNames,
  ).filter((skillName) => !releasedSkills.has(skillName));

  if (skillNames.length === 0) {
    throw new Error(
      'PostPlus public skill catalog has no released skills.',
    );
  }

  await protectLocallyModifiedSkills({
    action: 'update',
    dependencies,
    scope: options.scope,
  });

  const baselineIsCurrent = !shouldRepairManagedBaseline({
    baseline,
    releaseId: catalog.releaseId,
    skillNames,
  });
  if (baselineIsCurrent && retiredSkillNames.length === 0) {
    try {
      await verifyPostPlusSkillUpdate({
        dependencies,
        releasedSkillNames: skillNames,
        retiredSkillNames,
        scope: options.scope,
      });
      reportPostPlusSkillReconcileSuccess({
        catalog,
        dependencies,
        outcome: 'current',
        options,
        retiredSkillCount: 0,
        skillCount: skillNames.length,
      });
      return 0;
    } catch (error) {
      if (!(error instanceof SkillReconciliationError)) {
        throw error;
      }
    }
  }

  await assertPostPlusSkillsBaselineWritable(options.scope);
  for (const agentTarget of POSTPLUS_SKILLS_AGENT_TARGETS) {
    const updateExitCode = await dependencies.runInteractiveCommand(
      'npx',
      buildPostPlusSkillUpdateArgs(skillNames, options.scope, agentTarget),
    );

    if (updateExitCode !== 0) {
      return updateExitCode;
    }
  }

  if (retiredSkillNames.length > 0) {
    const removeExitCode = await dependencies.runInteractiveCommand(
      'npx',
      buildPostPlusSkillUninstallArgs(retiredSkillNames, options.scope),
    );

    if (removeExitCode !== 0) {
      return removeExitCode;
    }
  }

  await verifyPostPlusSkillUpdate({
    dependencies,
    releasedSkillNames: skillNames,
    retiredSkillNames,
    scope: options.scope,
  });

  await writeManagedSkillBaseline(
    {
      releaseId: catalog.releaseId,
      skillNames,
    },
    options.scope,
  );
  await writeCurrentCliVersionToLocalConfig();
  await clearUpdateCheckCache();
  reportPostPlusSkillReconcileSuccess({
    catalog,
    dependencies,
    outcome:
      baseline.releaseId === null
        ? 'ready'
        : baseline.releaseId === catalog.releaseId
          ? 'repaired'
          : 'updated',
    options,
    retiredSkillCount: retiredSkillNames.length,
    skillCount: skillNames.length,
  });

  return 0;
}

function reportPostPlusSkillReconcileSuccess(input: {
  catalog: Awaited<ReturnType<typeof loadPublicSkillCatalog>>;
  dependencies: SkillMutationDependencies;
  options: SkillMutationOptions;
  outcome: 'current' | 'ready' | 'repaired' | 'updated';
  retiredSkillCount: number;
  skillCount: number;
}): void {
  const reportSuccess = input.dependencies.reportSuccess;
  if (!reportSuccess) {
    return;
  }

  if (input.options.messageMode === 'implicit') {
    if (input.outcome === 'updated' && input.catalog.releaseNotes) {
      reportSuccess(
        `PostPlus Skills updated: ${input.catalog.releaseNotes.title}. ${input.catalog.releaseNotes.summary}`,
      );
    } else if (input.outcome === 'ready') {
      reportSuccess(
        `PostPlus is ready with ${input.skillCount} verified official Skills.`,
      );
    } else if (input.outcome === 'repaired') {
      reportSuccess('PostPlus Skills repaired and verified.');
    }
    return;
  }

  if (input.outcome === 'current') {
    reportSuccess(
      `PostPlus is already current: ${input.skillCount} official Skills verified (${input.options.scope}).`,
    );
    return;
  }

  if (input.outcome === 'ready') {
    reportSuccess(
      [
        `PostPlus is ready: ${input.skillCount} official Skills installed and verified (${input.options.scope}).`,
        ...(input.catalog.productBrief
          ? ['', input.catalog.productBrief.paragraphs.join('\n\n')]
          : []),
        '',
        'Start a new agent session to use them; run `postplus list` to browse available capabilities.',
      ].join('\n'),
    );
    return;
  }

  reportSuccess(
    input.outcome === 'repaired'
      ? `PostPlus Skills repaired and verified: ${input.skillCount} current, ${input.retiredSkillCount} retired removed (${input.options.scope}).`
      : `PostPlus Skills updated: ${input.skillCount} current, ${input.retiredSkillCount} retired removed (${input.options.scope}).`,
  );

  if (input.outcome === 'updated' && input.catalog.releaseNotes) {
    reportSuccess(
      [
        `PostPlus update ${input.catalog.releaseNotes.releaseId}: ${input.catalog.releaseNotes.title}`,
        input.catalog.releaseNotes.summary,
        ...input.catalog.releaseNotes.highlights.map(
          (highlight) => `- ${highlight}`,
        ),
      ].join('\n'),
    );
  }
}

class SkillReconciliationError extends Error {
  readonly code = 'postplus_skill_reconciliation_failed';
}

export async function runPostPlusSkillUninstall(
  dependencies: SkillMutationDependencies = {
    confirmModifiedSkillBackup: confirmModifiedSkillBackup,
    isInteractive: () => process.stdin.isTTY === true,
    reportSuccess: (message) => process.stdout.write(`${message}\n`),
    runCommand,
    runInteractiveCommand,
  },
  options: SkillMutationOptions = DEFAULT_SKILL_MUTATION_OPTIONS,
): Promise<number> {
  return withPostPlusSkillsMutationLock(options.scope, () =>
    uninstallPostPlusSkills(dependencies, options),
  );
}

async function uninstallPostPlusSkills(
  dependencies: SkillMutationDependencies,
  options: SkillMutationOptions,
): Promise<number> {
  const catalog = await loadPublicSkillCatalog();
  const skillNames = catalog.skills.map((skill) => skill.skillId);
  const baseline = await readManagedSkillBaseline(options.scope);
  const lockedSkillNames = await readPostPlusInstallerLockedSkillEntries(
    options.scope,
  ).then((entries) => entries.map((entry) => entry.name));
  const allKnownSkillNames = mergeSkillNames(
    mergeSkillNames(skillNames, baseline.skillNames),
    lockedSkillNames,
  );

  if (allKnownSkillNames.length === 0) {
    throw new Error(
      'PostPlus public skill catalog has no released skills.',
    );
  }

  await protectLocallyModifiedSkills({
    action: 'uninstall',
    dependencies,
    scope: options.scope,
  });

  const exitCode = await dependencies.runInteractiveCommand(
    'npx',
    buildPostPlusSkillUninstallArgs(allKnownSkillNames, options.scope),
  );

  if (exitCode !== 0) {
    return exitCode;
  }

  await verifyPostPlusSkillUninstall({
    dependencies,
    removedSkillNames: allKnownSkillNames,
    scope: options.scope,
  });

  await clearManagedSkillBaseline(options.scope);
  await clearUpdateCheckCache();
  dependencies.reportSuccess?.(
    `PostPlus skills uninstalled: ${allKnownSkillNames.length} managed skills removed (${options.scope}). Restart active agent sessions to refresh skill discovery.`,
  );

  return 0;
}

export async function generateSkillInstallStatusReport(
  dependencies: SkillManagementDependencies = {
    runCommand,
  },
): Promise<SkillInstallStatusReport> {
  return (await inspectPostPlusSkillInstall(dependencies)).report;
}

export async function runPostPlusSkillVerify(
  dependencies: SkillManagementDependencies = {
    runCommand,
  },
): Promise<SkillBaselineVerifyReport> {
  const inspection = await inspectPostPlusSkillInstall(dependencies);
  const previousManagedSkillsReleaseId =
    inspection.report.managedSkillsReleaseId;

  if (!inspection.report.ok) {
    return {
      ...inspection.report,
      baselineUpdated: false,
      previousManagedSkillsReleaseId,
      verifiedSkillsReleaseId: null,
    };
  }

  return {
    ...inspection.report,
    baselineUpdated: false,
    previousManagedSkillsReleaseId,
    verifiedSkillsReleaseId: inspection.report.managedSkillsReleaseId,
  };
}

async function inspectPostPlusSkillInstall(
  dependencies: SkillManagementDependencies,
): Promise<{
  catalog: Awaited<ReturnType<typeof loadPublicSkillCatalog>>;
  report: SkillInstallStatusReport;
  requiredSkillNames: string[];
}> {
  const catalog = await loadPublicSkillCatalog();
  const requiredSkillNames = catalog.skills.map((skill) => skill.skillId);
  const requiredSkills = new Set(requiredSkillNames);
  const scope = await resolvePostPlusSkillsScope();
  const baseline = await readManagedSkillBaseline(scope);
  const baselineRetiredManagedSkills = baseline.skillNames.filter(
    (skillName) => !requiredSkills.has(skillName),
  );

  try {
    const installed = await listInstalledSkillsForMutationScope(
      dependencies,
      scope,
    );
    const baselineRetiredSkills = new Set(baselineRetiredManagedSkills);
    const lockedSkills = new Set(
      (await readPostPlusInstallerLockedSkillEntries(scope)).map(
        (entry) => `${entry.scope}:${entry.name}`,
      ),
    );
    const installedRetiredManagedSkills = [
      ...new Set(
        installed
          .filter(
            (skill) =>
              baselineRetiredSkills.has(skill.name) ||
              lockedSkills.has(`${skill.scope}:${skill.name}`),
          )
          .map((skill) => skill.name),
      ),
    ]
      .filter((skillName) => !requiredSkills.has(skillName))
      .sort((a, b) => a.localeCompare(b));
    const retiredManagedSkills = mergeSkillNames(
      baselineRetiredManagedSkills,
      installedRetiredManagedSkills,
    );
    const postPlusInstalled = installed.filter((skill) =>
      requiredSkills.has(skill.name),
    );
    const installedNames = new Set(
      postPlusInstalled.map((skill) => skill.name),
    );
    const missingSkills = [...requiredSkills].filter(
      (skill) => !installedNames.has(skill),
    );
    const baselineIsCurrent = !shouldRepairManagedBaseline({
      baseline,
      releaseId: catalog.releaseId,
      skillNames: requiredSkillNames,
    });

    const scopes = [
      ...new Set(
        postPlusInstalled
          .map((skill) => skill.scope)
          .filter((scope) => scope.trim().length > 0),
      ),
    ].sort();

    return {
      catalog,
      report: {
        ok:
          missingSkills.length === 0 &&
          installedRetiredManagedSkills.length === 0 &&
          baselineIsCurrent,
        error: baselineIsCurrent
          ? null
          : 'This installation has no verified current release. Run postplus update to install and verify it.',
        installCommand: formatPostPlusSkillsInstallCommand(
          catalog.source,
          scope,
        ),
        installedCount: installedNames.size,
        managedSkillsReleaseId: baseline.releaseId,
        missingSkills,
        requiredCount: requiredSkills.size,
        retiredManagedSkills,
        scopes,
        source: catalog.source,
        updateCommand: formatPostPlusSkillUpdateCommand(scope),
        uninstallCommand: formatPostPlusSkillUninstallCommand(scope),
      },
      requiredSkillNames,
    };
  } catch (error) {
    return {
      catalog,
      report: {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to inspect installed PostPlus skills.',
        installCommand: formatPostPlusSkillsInstallCommand(
          catalog.source,
          scope,
        ),
        installedCount: 0,
        managedSkillsReleaseId: baseline.releaseId,
        missingSkills: [...requiredSkills],
        requiredCount: requiredSkills.size,
        retiredManagedSkills: baselineRetiredManagedSkills,
        scopes: [],
        source: catalog.source,
        updateCommand: formatPostPlusSkillUpdateCommand(scope),
        uninstallCommand: formatPostPlusSkillUninstallCommand(scope),
      },
      requiredSkillNames,
    };
  }
}

export function formatSkillInstallStatusReport(
  report: SkillInstallStatusReport,
): string {
  const lines = ['PostPlus skills status', ''];

  if (report.error) {
    lines.push(`[FAIL] Skill installer: ${report.error}`);
  } else if (report.ok) {
    lines.push(
      `[PASS] Installed released skills: ${report.installedCount}/${report.requiredCount}`,
    );
  } else {
    lines.push(
      `[FAIL] Installed released skills: ${report.installedCount}/${report.requiredCount}`,
    );
  }

  lines.push(`  Source: ${report.source}`);
  lines.push(
    `  Managed baseline: ${report.managedSkillsReleaseId ?? 'none'}`,
  );
  lines.push(
    `  Scope: ${report.scopes.length > 0 ? report.scopes.join(', ') : 'none detected'}`,
  );

  if (report.retiredManagedSkills.length > 0) {
    lines.push(
      `  Retired managed skills: ${formatSkillList(report.retiredManagedSkills, 8)}`,
      `  Cleanup: ${report.updateCommand}`,
    );
  }

  if (report.missingSkills.length > 0) {
    lines.push(
      `  Missing: ${formatSkillList(report.missingSkills, 8)}`,
      `  Fix: ${report.updateCommand}`,
    );
  } else {
    lines.push(`  Update: ${report.updateCommand}`);
  }

  return lines.join('\n');
}

export function formatSkillBaselineVerifyReport(
  report: SkillBaselineVerifyReport,
): string {
  const lines = ['PostPlus skills verify', ''];

  if (report.error) {
    lines.push(`[FAIL] Skill installer: ${report.error}`);
  } else if (report.ok) {
    lines.push(
      `[PASS] Installed released skills: ${report.installedCount}/${report.requiredCount}`,
    );
  } else {
    lines.push(
      `[FAIL] Installed released skills: ${report.installedCount}/${report.requiredCount}`,
    );
  }

  lines.push(`  Source: ${report.source}`);
  lines.push(
    `  Previous managed baseline: ${
      report.previousManagedSkillsReleaseId ?? 'none'
    }`,
  );

  if (report.verifiedSkillsReleaseId) {
    lines.push(`  Verified baseline: ${report.verifiedSkillsReleaseId}`);
    lines.push('  Next: postplus status');
  } else {
    lines.push('  Verified baseline: unchanged');
  }

  if (report.retiredManagedSkills.length > 0) {
    lines.push(
      `  Retired managed skills: ${formatSkillList(report.retiredManagedSkills, 8)}`,
      `  Cleanup: ${report.updateCommand}`,
    );
  }

  if (report.missingSkills.length > 0) {
    lines.push(
      `  Missing: ${formatSkillList(report.missingSkills, 8)}`,
      `  Fix: ${report.updateCommand}`,
    );
  }

  return lines.join('\n');
}

export function buildPostPlusSkillUpdateArgs(
  skillNames: string[],
  scope: PostPlusSkillsInstallScope = 'global',
  agentTarget?: (typeof POSTPLUS_SKILLS_AGENT_TARGETS)[number],
): string[] {
  if (skillNames.length === 0) {
    throw new Error('PostPlus public skill catalog has no released skills.');
  }

  const skillsSource = resolvePostPlusSkillsSource();

  return [
    ...NPX_SKILLS,
    'add',
    skillsSource,
    ...buildSkillScopeArgs(scope),
    '--full-depth',
    '--skill',
    '*',
    '--agent',
    ...(agentTarget ? [agentTarget] : POSTPLUS_SKILLS_AGENT_TARGETS),
    '--yes',
  ];
}

export function buildPostPlusSkillUninstallArgs(
  skillNames: string[],
  scope: PostPlusSkillsInstallScope = 'global',
): string[] {
  return [
    ...NPX_SKILLS,
    'remove',
    ...skillNames,
    ...buildSkillScopeArgs(scope),
    '--yes',
  ];
}

export function formatPostPlusSkillUpdateCommand(
  scope: PostPlusSkillsInstallScope = 'global',
): string {
  return scope === 'global'
    ? 'postplus update'
    : 'postplus update --current-directory';
}

export function formatPostPlusSkillUninstallCommand(
  scope: PostPlusSkillsInstallScope = 'global',
): string {
  return scope === 'global'
    ? 'postplus uninstall'
    : 'postplus uninstall --current-directory';
}

function buildSkillScopeArgs(scope: PostPlusSkillsInstallScope): string[] {
  return scope === 'global' ? ['--global'] : [];
}

function mergeSkillNames(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])].sort((a, b) => a.localeCompare(b));
}

function shouldRepairManagedBaseline(input: {
  baseline: { releaseId: string | null; skillNames: string[] };
  releaseId: string;
  skillNames: string[];
}): boolean {
  if (input.baseline.releaseId !== input.releaseId) {
    return true;
  }

  return !haveSameSkillNames(input.baseline.skillNames, input.skillNames);
}

function haveSameSkillNames(left: string[], right: string[]): boolean {
  const normalizedLeft = mergeSkillNames(left, []);
  const normalizedRight = mergeSkillNames(right, []);

  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

async function protectLocallyModifiedSkills(input: {
  action: 'uninstall' | 'update';
  dependencies: SkillMutationDependencies;
  scope: PostPlusSkillsInstallScope;
}): Promise<void> {
  const lockedEntries = await readPostPlusInstallerLockedSkillEntries(
    input.scope,
  );
  const verifiableEntries = lockedEntries.filter(
    (entry) => entry.expectedContentHash && entry.hashKind,
  );

  if (verifiableEntries.length === 0) {
    return;
  }

  const installed = await listInstalledSkillsForMutationScope(
    input.dependencies,
    input.scope,
  );
  const installedByName = new Map(
    installed.map((entry) => [entry.name, entry] as const),
  );
  const modifiedSkills: ModifiedInstalledSkill[] = [];

  for (const lockedEntry of verifiableEntries) {
    const installedEntry = installedByName.get(lockedEntry.name);
    if (!installedEntry || !lockedEntry.expectedContentHash) {
      continue;
    }

    const actualContentHash =
      lockedEntry.hashKind === 'git-tree-sha1'
        ? await computeGitTreeHash(installedEntry.path)
        : await computeSkillFolderHash(installedEntry.path);

    if (actualContentHash !== lockedEntry.expectedContentHash) {
      modifiedSkills.push({
        actualContentHash,
        expectedContentHash: lockedEntry.expectedContentHash,
        installedPath: installedEntry.path,
        name: lockedEntry.name,
      });
    }
  }

  if (modifiedSkills.length === 0) {
    return;
  }

  const skillNames = modifiedSkills.map((skill) => skill.name);
  if (input.dependencies.isInteractive?.() !== true) {
    const retryCommand =
      input.action === 'update'
        ? formatPostPlusSkillUpdateCommand(input.scope)
        : formatPostPlusSkillUninstallCommand(input.scope);
    throw new Error(
      `Locally modified PostPlus skills require confirmation before ${input.action}: ${formatSkillList(skillNames, 8)}. Re-run ${retryCommand} in an interactive terminal to back them up before continuing. Managed baseline was not changed.`,
    );
  }

  const confirmed = await (
    input.dependencies.confirmModifiedSkillBackup ??
    confirmModifiedSkillBackup
  )({
    action: input.action,
    scope: input.scope,
    skillNames,
  });

  if (!confirmed) {
    throw new Error(
      `PostPlus skills ${input.action} cancelled before changing locally modified skills. Managed baseline was not changed.`,
    );
  }

  const backupPath = await backupModifiedSkills(
    modifiedSkills,
    input.scope,
  );
  input.dependencies.reportSuccess?.(
    `Backed up ${modifiedSkills.length} locally modified PostPlus skill${modifiedSkills.length === 1 ? '' : 's'} to ${backupPath}.`,
  );
}

async function confirmModifiedSkillBackup(
  input: ModifiedSkillBackupPrompt,
): Promise<boolean> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    process.stdout.write(
      `Locally modified PostPlus skills detected (${input.scope}): ${formatSkillList(input.skillNames, 8)}\n`,
    );
    const answer = await terminal.question(
      input.action === 'update'
        ? 'Back up the local versions and install the official release? [Y/n] '
        : 'Back up the local versions and uninstall the managed skills? [Y/n] ',
    );
    const normalized = answer.trim().toLowerCase();
    return normalized === '' || normalized === 'y' || normalized === 'yes';
  } finally {
    terminal.close();
  }
}

async function backupModifiedSkills(
  skills: ModifiedInstalledSkill[],
  scope: PostPlusSkillsInstallScope,
): Promise<string> {
  const backupRoot = join(getPostPlusConfigDir(), 'skill-backups');
  await mkdir(backupRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = await mkdtemp(join(backupRoot, `${timestamp}-`));
  const manifestEntries: Array<
    ModifiedInstalledSkill & { backupPath: string }
  > = [];

  for (const skill of skills) {
    const sourcePath = await realpath(skill.installedPath);
    const skillBackupPath = join(
      backupPath,
      `skill-${Buffer.from(skill.name).toString('base64url')}`,
    );
    await cp(sourcePath, skillBackupPath, {
      recursive: true,
      verbatimSymlinks: true,
    });
    manifestEntries.push({
      ...skill,
      backupPath: skillBackupPath,
    });
  }

  await writeFile(
    join(backupPath, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        scope,
        skills: manifestEntries,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return backupPath;
}

async function computeGitTreeHash(directoryPath: string): Promise<string> {
  return (await computeGitTreeObject(directoryPath)).toString('hex');
}

async function computeGitTreeObject(directoryPath: string): Promise<Buffer> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const parts: Buffer[] = [];

  for (const entry of entries.sort((left, right) => {
    const leftGitName = `${left.name}${left.isDirectory() ? '/' : ''}`;
    const rightGitName = `${right.name}${right.isDirectory() ? '/' : ''}`;
    return Buffer.from(leftGitName).compare(Buffer.from(rightGitName));
  })) {
    const entryPath = join(directoryPath, entry.name);
    const entryStat = await lstat(entryPath);
    let mode: string;
    let objectHash: Buffer;

    if (entryStat.isDirectory()) {
      mode = '40000';
      objectHash = await computeGitTreeObject(entryPath);
    } else if (entryStat.isSymbolicLink()) {
      mode = '120000';
      objectHash = computeGitObjectHash(
        'blob',
        Buffer.from(await readlink(entryPath)),
      );
    } else if (entryStat.isFile()) {
      mode = entryStat.mode & 0o111 ? '100755' : '100644';
      objectHash = computeGitObjectHash('blob', await readFile(entryPath));
    } else {
      continue;
    }

    parts.push(
      Buffer.concat([Buffer.from(`${mode} ${entry.name}\0`), objectHash]),
    );
  }

  return computeGitObjectHash('tree', Buffer.concat(parts));
}

function computeGitObjectHash(type: 'blob' | 'tree', content: Buffer): Buffer {
  return createHash('sha1')
    .update(`${type} ${content.length}\0`)
    .update(content)
    .digest();
}

async function computeSkillFolderHash(directoryPath: string): Promise<string> {
  const files: Array<{ content: Buffer; relativePath: string }> = [];
  await collectSkillFiles(directoryPath, directoryPath, files);
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const hash = createHash('sha256');

  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }

  return hash.digest('hex');
}

async function collectSkillFiles(
  baseDirectory: string,
  currentDirectory: string,
  files: Array<{ content: Buffer; relativePath: string }>,
): Promise<void> {
  const entries = await readdir(currentDirectory, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') {
          return;
        }
        await collectSkillFiles(baseDirectory, entryPath, files);
      } else if (entry.isFile()) {
        files.push({
          content: await readFile(entryPath),
          relativePath: relative(baseDirectory, entryPath).split(sep).join('/'),
        });
      }
    }),
  );
}

async function verifyPostPlusSkillUpdate(input: {
  dependencies: SkillManagementDependencies;
  releasedSkillNames: string[];
  retiredSkillNames: string[];
  scope: PostPlusSkillsInstallScope;
}): Promise<void> {
  const installed = await listInstalledSkillsForMutationScope(
    input.dependencies,
    input.scope,
  );
  const installedNames = new Set(installed.map((skill) => skill.name));
  const releasedSkills = new Set(input.releasedSkillNames);
  const missingSkills = input.releasedSkillNames.filter(
    (skillName) => !installedNames.has(skillName),
  );
  const lockedSkillNames = (
    await readPostPlusInstallerLockedSkillEntries(input.scope)
  ).map((entry) => entry.name);
  const retiredSkills = mergeSkillNames(
    input.retiredSkillNames.filter((skillName) =>
      installedNames.has(skillName),
    ),
    lockedSkillNames.filter((skillName) => !releasedSkills.has(skillName)),
  );

  if (missingSkills.length === 0 && retiredSkills.length === 0) {
    return;
  }

  throw new SkillReconciliationError(
    formatSkillReconciliationError({
      action: 'update',
      missingSkills,
      residualSkills: retiredSkills,
      scope: input.scope,
    }),
  );
}

async function verifyPostPlusSkillUninstall(input: {
  dependencies: SkillManagementDependencies;
  removedSkillNames: string[];
  scope: PostPlusSkillsInstallScope;
}): Promise<void> {
  const installed = await listInstalledSkillsForMutationScope(
    input.dependencies,
    input.scope,
  );
  const removedSkills = new Set(input.removedSkillNames);
  const residualInstalledSkills = installed
    .map((skill) => skill.name)
    .filter((skillName) => removedSkills.has(skillName));
  const residualLockedSkills = (
    await readPostPlusInstallerLockedSkillEntries(input.scope)
  ).map((entry) => entry.name);
  const residualSkills = mergeSkillNames(
    residualInstalledSkills,
    residualLockedSkills,
  );

  if (residualSkills.length === 0) {
    return;
  }

  throw new SkillReconciliationError(
    formatSkillReconciliationError({
      action: 'uninstall',
      missingSkills: [],
      residualSkills,
      scope: input.scope,
    }),
  );
}

function formatSkillReconciliationError(input: {
  action: 'uninstall' | 'update';
  missingSkills: string[];
  residualSkills: string[];
  scope: PostPlusSkillsInstallScope;
}): string {
  const details: string[] = [];

  if (input.missingSkills.length > 0) {
    details.push(`missing: ${formatSkillList(input.missingSkills, 8)}`);
  }
  if (input.residualSkills.length > 0) {
    details.push(
      `still present: ${formatSkillList(input.residualSkills, 8)}`,
    );
  }

  return `PostPlus skills ${input.action} did not converge in ${input.scope} scope (${details.join('; ')}). Managed baseline was not changed.`;
}

async function listInstalledSkillsForMutationScope(
  dependencies: SkillManagementDependencies,
  scope: PostPlusSkillsInstallScope,
): Promise<InstalledSkillEntry[]> {
  const installed = await listInstalledSkillsForScope(
    dependencies,
    buildSkillScopeArgs(scope),
  );

  const installerScope = scope === 'global' ? 'global' : 'project';
  return installed.filter((skill) => skill.scope === installerScope);
}

async function listInstalledSkillsForScope(
  dependencies: SkillManagementDependencies,
  scopeArgs: string[],
): Promise<InstalledSkillEntry[]> {
  const result = await dependencies.runCommand(
    'npx',
    [...NPX_SKILLS, 'list', '--json', ...scopeArgs],
    {
      timeoutMs: 60_000,
    },
  );
  const parsed = JSON.parse(result.stdout) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('`skills list --json` returned an invalid payload.');
  }

  return parsed.map(normalizeInstalledSkillEntry);
}

function normalizeInstalledSkillEntry(value: unknown): InstalledSkillEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('`skills list --json` returned an invalid skill entry.');
  }

  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const skillPath = typeof record.path === 'string' ? record.path.trim() : '';
  const scope = typeof record.scope === 'string' ? record.scope.trim() : '';
  const agents = Array.isArray(record.agents)
    ? record.agents
        .filter((agent): agent is string => typeof agent === 'string')
        .map((agent) => agent.trim())
        .filter(Boolean)
    : [];

  if (!name || !skillPath || !scope) {
    throw new Error('`skills list --json` returned an incomplete skill entry.');
  }

  return {
    agents,
    name,
    path: skillPath,
    scope,
  };
}

function formatSkillList(skills: string[], limit: number): string {
  const visible = skills.slice(0, limit);
  const rest = skills.length - visible.length;

  return rest > 0
    ? `${visible.join(', ')} (+${rest} more)`
    : visible.join(', ');
}
