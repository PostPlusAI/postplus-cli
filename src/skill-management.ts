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

const NPX_SKILLS = ['-y', 'skills'];
const SKILLS_INSTALLER_GLOBAL_LOCK_PATH = ['.agents', '.skill-lock.json'];
const SKILLS_INSTALLER_PROJECT_LOCK_PATH = 'skills-lock.json';
const SKILLS_INSTALLER_POSTPLUS_SOURCE = 'postplusai/postplus-skills';

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

type SkillInstallStatusOptions = {
  repairManagedBaseline?: boolean;
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
  scope: PostPlusSkillsInstallScope;
};

type PostPlusInstallerLockedSkillEntry = {
  expectedContentHash: string | null;
  hashKind: 'folder-sha256' | 'git-tree-sha1' | null;
  name: string;
  scope: 'global' | 'project';
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

export async function runPostPlusSkillUpdate(
  dependencies: SkillMutationDependencies = {
    confirmModifiedSkillBackup: confirmModifiedSkillBackup,
    isInteractive: () => process.stdin.isTTY === true,
    reportSuccess: (message) => process.stdout.write(`${message}\n`),
    runCommand,
    runInteractiveCommand,
  },
  options: SkillMutationOptions = DEFAULT_SKILL_MUTATION_OPTIONS,
): Promise<number> {
  const catalog = await loadPublicSkillCatalog();
  const skillNames = catalog.skills.map((skill) => skill.skillId);
  const releasedSkills = new Set(skillNames);
  const baseline = await readManagedSkillBaseline();
  const lockedSkillNames = await readPostPlusInstallerLockedSkillEntries(
    options.scope,
  ).then((entries) => entries.map((entry) => entry.name));
  const retiredSkillNames = mergeSkillNames(
    baseline.skillNames,
    lockedSkillNames,
  ).filter((skillName) => !releasedSkills.has(skillName));

  if (skillNames.length === 0) {
    throw new Error('PostPlus public skill catalog has no released skills.');
  }

  await protectLocallyModifiedSkills({
    action: 'update',
    dependencies,
    scope: options.scope,
  });

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

  await writeManagedSkillBaseline({
    releaseId: catalog.releaseId,
    skillNames,
  });
  await writeCurrentCliVersionToLocalConfig();
  await clearUpdateCheckCache();
  dependencies.reportSuccess?.(
    `PostPlus skills synchronized: ${skillNames.length} current, ${retiredSkillNames.length} retired removed (${options.scope}). Restart active agent sessions to refresh skill discovery.`,
  );

  return 0;
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
  const catalog = await loadPublicSkillCatalog();
  const skillNames = catalog.skills.map((skill) => skill.skillId);
  const baseline = await readManagedSkillBaseline();
  const lockedSkillNames = await readPostPlusInstallerLockedSkillEntries(
    options.scope,
  ).then((entries) => entries.map((entry) => entry.name));
  const allKnownSkillNames = mergeSkillNames(
    mergeSkillNames(skillNames, baseline.skillNames),
    lockedSkillNames,
  );

  if (allKnownSkillNames.length === 0) {
    throw new Error('PostPlus public skill catalog has no released skills.');
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

  await clearManagedSkillBaseline();
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
  options: SkillInstallStatusOptions = {},
): Promise<SkillInstallStatusReport> {
  return (await inspectPostPlusSkillInstall(dependencies, options)).report;
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

  await writeManagedSkillBaseline({
    releaseId: inspection.catalog.releaseId,
    skillNames: inspection.requiredSkillNames,
  });
  await writeCurrentCliVersionToLocalConfig();
  await clearUpdateCheckCache();

  return {
    ...inspection.report,
    baselineUpdated: true,
    managedSkillsReleaseId: inspection.catalog.releaseId,
    previousManagedSkillsReleaseId,
    verifiedSkillsReleaseId: inspection.catalog.releaseId,
  };
}

async function inspectPostPlusSkillInstall(
  dependencies: SkillManagementDependencies,
  options: SkillInstallStatusOptions = {},
): Promise<{
  catalog: Awaited<ReturnType<typeof loadPublicSkillCatalog>>;
  report: SkillInstallStatusReport;
  requiredSkillNames: string[];
}> {
  const catalog = await loadPublicSkillCatalog();
  const requiredSkillNames = catalog.skills.map((skill) => skill.skillId);
  const requiredSkills = new Set(requiredSkillNames);
  const baseline = await readManagedSkillBaseline();
  const baselineRetiredManagedSkills = baseline.skillNames.filter(
    (skillName) => !requiredSkills.has(skillName),
  );

  try {
    const installed = await listInstalledSkills(dependencies);
    const baselineRetiredSkills = new Set(baselineRetiredManagedSkills);
    const lockedSkills = new Set(
      (await readPostPlusInstallerLockedSkillEntries()).map(
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
    let managedSkillsReleaseId = baseline.releaseId;
    let currentRetiredManagedSkills = retiredManagedSkills;

    if (
      options.repairManagedBaseline === true &&
      missingSkills.length === 0 &&
      shouldRepairManagedBaseline({
        baseline,
        releaseId: catalog.releaseId,
        skillNames: requiredSkillNames,
      }) &&
      installedRetiredManagedSkills.length === 0
    ) {
      await writeManagedSkillBaseline({
        releaseId: catalog.releaseId,
        skillNames: requiredSkillNames,
      });
      await writeCurrentCliVersionToLocalConfig();
      await clearUpdateCheckCache();
      managedSkillsReleaseId = catalog.releaseId;
      currentRetiredManagedSkills = [];
    }

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
          installedRetiredManagedSkills.length === 0,
        error: null,
        installCommand: formatPostPlusSkillsInstallCommand(catalog.source),
        installedCount: installedNames.size,
        managedSkillsReleaseId,
        missingSkills,
        requiredCount: requiredSkills.size,
        retiredManagedSkills: currentRetiredManagedSkills,
        scopes,
        source: catalog.source,
        updateCommand: formatPostPlusSkillUpdateCommand(),
        uninstallCommand: formatPostPlusSkillUninstallCommand(),
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
        installCommand: formatPostPlusSkillsInstallCommand(catalog.source),
        installedCount: 0,
        managedSkillsReleaseId: baseline.releaseId,
        missingSkills: [...requiredSkills],
        requiredCount: requiredSkills.size,
        retiredManagedSkills: baselineRetiredManagedSkills,
        scopes: [],
        source: catalog.source,
        updateCommand: formatPostPlusSkillUpdateCommand(),
        uninstallCommand: formatPostPlusSkillUninstallCommand(),
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
  lines.push(`  Managed baseline: ${report.managedSkillsReleaseId ?? 'none'}`);
  lines.push(
    `  Scope: ${report.scopes.length > 0 ? report.scopes.join(', ') : 'none detected'}`,
  );

  if (report.retiredManagedSkills.length > 0) {
    lines.push(
      `  Retired managed skills: ${formatSkillList(report.retiredManagedSkills, 8)}`,
      `  Cleanup (global): ${report.updateCommand}`,
      `  Cleanup (current directory): ${formatPostPlusSkillUpdateCommand('current-directory')}`,
    );
  }

  if (report.missingSkills.length > 0) {
    lines.push(
      `  Missing: ${formatSkillList(report.missingSkills, 8)}`,
      `  Fix (global): ${report.installCommand}`,
      `  Fix (current directory): ${formatPostPlusSkillsInstallCommand(report.source, 'current-directory')}`,
    );
  } else {
    lines.push(
      `  Update (global): ${report.updateCommand}`,
      `  Update (current directory): ${formatPostPlusSkillUpdateCommand('current-directory')}`,
    );
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

  if (report.baselineUpdated && report.verifiedSkillsReleaseId) {
    lines.push(`  Verified baseline: ${report.verifiedSkillsReleaseId}`);
    lines.push('  Next: postplus status');
  } else {
    lines.push('  Verified baseline: unchanged');
  }

  if (report.retiredManagedSkills.length > 0) {
    lines.push(
      `  Retired managed skills: ${formatSkillList(report.retiredManagedSkills, 8)}`,
      `  Cleanup (global): ${report.updateCommand}`,
      `  Cleanup (current directory): ${formatPostPlusSkillUpdateCommand('current-directory')}`,
    );
  }

  if (report.missingSkills.length > 0) {
    lines.push(
      `  Missing: ${formatSkillList(report.missingSkills, 8)}`,
      `  Fix (global): ${report.installCommand}`,
      `  Fix (current directory): ${formatPostPlusSkillsInstallCommand(report.source, 'current-directory')}`,
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
    input.dependencies.confirmModifiedSkillBackup ?? confirmModifiedSkillBackup
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

  const backupPath = await backupModifiedSkills(modifiedSkills, input.scope);
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

  throw new Error(
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

  throw new Error(
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
    details.push(`still present: ${formatSkillList(input.residualSkills, 8)}`);
  }

  return `PostPlus skills ${input.action} did not converge in ${input.scope} scope (${details.join('; ')}). Managed baseline was not changed.`;
}

async function readPostPlusInstallerLockedSkillEntries(
  scope?: PostPlusSkillsInstallScope,
): Promise<PostPlusInstallerLockedSkillEntry[]> {
  const lockPaths =
    scope === 'global'
      ? [{ path: getSkillsInstallerGlobalLockPath(), scope: 'global' as const }]
      : scope === 'current-directory'
        ? [
            {
              path: getSkillsInstallerProjectLockPath(),
              scope: 'project' as const,
            },
          ]
        : [
            {
              path: getSkillsInstallerProjectLockPath(),
              scope: 'project' as const,
            },
            {
              path: getSkillsInstallerGlobalLockPath(),
              scope: 'global' as const,
            },
          ];
  const entries = await Promise.all(
    lockPaths.map((lock) =>
      readPostPlusInstallerLockedSkillNamesFromPath(lock.path).then(
        (lockedEntries) =>
          lockedEntries.map((entry) => ({
            ...entry,
            scope: lock.scope,
          })),
      ),
    ),
  );

  return entries
    .flat()
    .sort(
      (left, right) =>
        left.scope.localeCompare(right.scope) ||
        left.name.localeCompare(right.name),
    );
}

async function readPostPlusInstallerLockedSkillNamesFromPath(
  lockPath: string,
): Promise<
  Array<{
    expectedContentHash: string | null;
    hashKind: 'folder-sha256' | 'git-tree-sha1' | null;
    name: string;
  }>
> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const payload = JSON.parse(raw) as unknown;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return [];
    }

    const record = payload as Record<string, unknown>;
    if (typeof record.version !== 'number') {
      return [];
    }

    if (!record.skills || typeof record.skills !== 'object') {
      return [];
    }

    return Object.entries(record.skills as Record<string, unknown>)
      .filter(([, entry]) => isPostPlusSkillsInstallerLockEntry(entry))
      .map(([skillName, entry]) => ({
        ...readInstallerLockContentHash(entry),
        name: skillName.trim(),
      }))
      .filter((entry) => Boolean(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function readInstallerLockContentHash(
  entry: unknown,
): Pick<PostPlusInstallerLockedSkillEntry, 'expectedContentHash' | 'hashKind'> {
  const record = entry as Record<string, unknown>;
  const skillFolderHash =
    typeof record.skillFolderHash === 'string'
      ? record.skillFolderHash.trim().toLowerCase()
      : '';
  if (/^[0-9a-f]{40}$/.test(skillFolderHash)) {
    return {
      expectedContentHash: skillFolderHash,
      hashKind: 'git-tree-sha1',
    };
  }

  const computedHash =
    typeof record.computedHash === 'string'
      ? record.computedHash.trim().toLowerCase()
      : '';
  if (/^[0-9a-f]{64}$/.test(computedHash)) {
    return {
      expectedContentHash: computedHash,
      hashKind: 'folder-sha256',
    };
  }

  return {
    expectedContentHash: null,
    hashKind: null,
  };
}

function isPostPlusSkillsInstallerLockEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }

  const record = entry as Record<string, unknown>;
  const source = typeof record.source === 'string' ? record.source.trim() : '';
  const sourceUrl =
    typeof record.sourceUrl === 'string' ? record.sourceUrl.trim() : '';

  return (
    normalizeSkillsInstallerSource(source) ===
      SKILLS_INSTALLER_POSTPLUS_SOURCE ||
    normalizeSkillsInstallerSource(sourceUrl) ===
      SKILLS_INSTALLER_POSTPLUS_SOURCE
  );
}

function normalizeSkillsInstallerSource(value: string): string {
  let normalized = value.trim().replace(/\\/g, '/');

  if (normalized.length === 0) {
    return '';
  }

  const sshMatch = normalized.match(/^git@[^:]+:(.+)$/);
  if (sshMatch) {
    normalized = sshMatch[1] ?? '';
  } else if (
    /^https?:\/\//i.test(normalized) ||
    /^ssh:\/\//i.test(normalized)
  ) {
    try {
      normalized = new URL(normalized).pathname.replace(/^\/+/, '');
    } catch {
      return normalized.toLowerCase();
    }
  }

  return normalized
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function getSkillsInstallerGlobalLockPath(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim();

  return xdgStateHome
    ? join(xdgStateHome, 'skills', '.skill-lock.json')
    : join(homedir(), ...SKILLS_INSTALLER_GLOBAL_LOCK_PATH);
}

function getSkillsInstallerProjectLockPath(): string {
  return join(process.cwd(), SKILLS_INSTALLER_PROJECT_LOCK_PATH);
}

async function listInstalledSkills(
  dependencies: SkillManagementDependencies,
): Promise<InstalledSkillEntry[]> {
  const project = await listInstalledSkillsForScope(dependencies, []);
  const global = await listInstalledSkillsForScope(dependencies, ['--global']);
  const byKey = new Map<string, InstalledSkillEntry>();

  for (const skill of [...project, ...global]) {
    byKey.set(`${skill.scope}:${skill.name}:${skill.path}`, skill);
  }

  return [...byKey.values()];
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
