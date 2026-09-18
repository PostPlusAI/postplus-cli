import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { writeCurrentCliVersionToLocalConfig } from './client-compatibility.js';
import { CommandInterruptedError, CommandTimeoutError, runCommand, runInteractiveCommand } from './command-runner.js';
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

import { PostPlusFailure } from './failure-contract.js';
import { hashSkillDirectory, SkillsBundleError, UnsupportedSkillEntryError } from './skills-bundle.js';

export const SKILLS_INSTALLER_ENTRY = fileURLToPath(new URL('../vendor/skills-runtime/cli.mjs', import.meta.url));
const SKILLS_INSTALLER_ARGS = [SKILLS_INSTALLER_ENTRY];

export type InstalledSkillEntry = {
  agents: string[];
  agentIds: string[];
  realPath: string | null;
  metadataName: string | null;
  metadataError: string | null;
  name: string;
  path: string;
  scope: 'global' | 'project' | string;
};

export type SkillInstallStatusReport = {
  ok: boolean;
  installedCount: number;
  missingSkills: string[];
  targetIssues?: { skill: string; agent: string; paths: string[] }[];
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
  command?: 'install' | 'update';
  json?: boolean;
  yes?: boolean;
  messageMode?: 'explicit' | 'implicit';
  scope: PostPlusSkillsInstallScope;
};

type ModifiedSkillBackupPrompt = {
  action: 'uninstall' | 'update' | 'install';
  scope: PostPlusSkillsInstallScope;
  skillNames: string[];
};

type ProtectedInstalledSkill = {
  actualContentHash: string;
  expectedContentHash: string | null;
  state: 'modified' | 'unverified';
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

  if (!catalog.contentHashes) {
    throw new SkillsBundleError('The selected skills source has no verified content manifest.');
  }
  if (baseline.releaseId && baseline.releaseId !== catalog.releaseId) {
    const previous = releaseOrder(baseline.releaseId);
    const target = releaseOrder(catalog.releaseId);
    if (!previous || !target) {
      throw new SkillMutationError('postplus_skills_release_order_unknown',
        'The installed and bundled skill releases cannot be ordered safely.',
        'Contact PostPlus support with the two release identifiers before replacing skills.');
    }
    if (previous.some((value, index) => value > target[index]! && previous.slice(0, index).every((part, earlier) => part === target[earlier]))) {
      throw new SkillMutationError('postplus_skills_downgrade_blocked',
        'The installed skills are newer than this CLI bundle.',
        'Update the CLI with postplus update before changing skills.');
    }
  }
  let installed = await listInstalledSkillsForMutationScope(dependencies, options.scope);
  let hashes = await readInstalledHashes(installed.filter((entry) => releasedSkills.has(entry.name) || retiredSkillNames.includes(entry.name)));
  const backup = await protectLocallyModifiedSkills({
    action: options.command ?? 'update', dependencies, scope: options.scope,
    yes: options.yes, json: options.json, targetHashes: catalog.contentHashes, managedNames: retiredSkillNames,
  });
  const baselineIsCurrent = !shouldRepairManagedBaseline({ baseline, releaseId: catalog.releaseId, skillNames });
  const targets: string[] = [];
  const removedInstalledSkills = installed.some((entry) => retiredSkillNames.includes(entry.name));
  await assertPostPlusSkillsBaselineWritable(options.scope);
  for (const agentTarget of POSTPLUS_SKILLS_AGENT_TARGETS) {
    const neededSkills = skillNames.filter((name) => !agentDirectoriesMatch(installed, hashes, name, agentTarget, catalog.contentHashes![name]!));
    if (neededSkills.length === 0) continue;
    targets.push(agentTarget);
    const updateExitCode = await runSkillInstaller(dependencies, formatPostPlusSkillsInstallCommand(undefined, options.scope),
      process.execPath, buildPostPlusSkillUpdateArgs(neededSkills, options.scope, agentTarget),
      { stdin: 'ignore', stdout: 'capture', timeoutMs: 300_000 },
    );
    if (updateExitCode !== 0) {
      throw new SkillMutationError('postplus_skill_install_failed',
        `Skill installation stopped at ${agentTarget}; completed targets will be reused.`,
        formatPostPlusSkillsInstallCommand(undefined, options.scope));
    }
    // The installer owns shared-directory/link behavior. Observe its actual
    // result before deciding whether another target still needs a write.
    installed = await listInstalledSkillsForMutationScope(dependencies, options.scope);
    hashes = await readInstalledHashes(installed.filter((entry) => releasedSkills.has(entry.name)));
  }

  if (retiredSkillNames.length > 0) {
    const removeExitCode = await runSkillInstaller(dependencies, formatPostPlusSkillsInstallCommand(undefined, options.scope),
      process.execPath,
      buildPostPlusSkillUninstallArgs(retiredSkillNames, options.scope),
      { stdin: 'ignore', stdout: 'capture', timeoutMs: 300_000 },
    );

    if (removeExitCode !== 0) {
      throw new SkillMutationError('postplus_skill_remove_failed', 'Retired skill removal failed.', formatPostPlusSkillsInstallCommand(undefined, options.scope));
    }
  }

  await verifyPostPlusSkillUpdate({
    dependencies,
    releasedSkillNames: skillNames,
    contentHashes: catalog.contentHashes,
    retiredSkillNames,
    scope: options.scope,
  });

  if (targets.length === 0 && retiredSkillNames.length === 0 && baselineIsCurrent &&
      Object.entries(catalog.contentHashes).every(([name, hash]) => baseline.contentHashes?.[name] === hash)) {
    reportPostPlusSkillReconcileSuccess({ catalog, dependencies, options, outcome: 'current', retiredSkillCount: 0, skillCount: skillNames.length, backup, changed: false });
    return 0;
  }

  await writeManagedSkillBaseline(
    {
      releaseId: catalog.releaseId,
      skillNames,
      contentHashes: catalog.contentHashes,
    },
    options.scope,
  );
  await writeCurrentCliVersionToLocalConfig();
  await clearUpdateCheckCache();
  reportPostPlusSkillReconcileSuccess({
    catalog,
    dependencies,
    outcome: targets.length === 0 && retiredSkillNames.length === 0 && baselineIsCurrent ? 'current' :
      baseline.releaseId === null && lockedSkillNames.length === 0
        ? 'ready'
        : baseline.releaseId === catalog.releaseId
          ? 'repaired'
          : 'updated',
    options,
    retiredSkillCount: retiredSkillNames.length,
    skillCount: skillNames.length,
    backup, changed: targets.length > 0 || removedInstalledSkills,
  });

  return 0;
}

type SkillBackup = { path: string; skillCount: number };

function reportPostPlusSkillReconcileSuccess(input: {
  catalog: Awaited<ReturnType<typeof loadPublicSkillCatalog>>;
  dependencies: SkillMutationDependencies;
  options: SkillMutationOptions;
  outcome: 'current' | 'ready' | 'repaired' | 'updated';
  retiredSkillCount: number;
  skillCount: number;
  changed: boolean;
  backup: SkillBackup | null;
}): void {
  const session = { newSessionRequired: input.changed,
    action: input.changed ? 'Start a new agent session to use the verified skills. Then say: "Help me get started with PostPlus" (or "带我开始使用 PostPlus").' : null };
  if (input.options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, outcome: input.outcome, releaseId: input.catalog.releaseId,
      skillCount: input.skillCount, retiredSkillCount: input.retiredSkillCount, scope: input.options.scope,
      diskReady: true, changed: input.changed, session, backup: input.backup })}\n`);
    return;
  }
  const summary = input.outcome === 'current'
    ? `PostPlus is already current: ${input.skillCount} official Skills verified (${input.options.scope}).`
    : input.outcome === 'ready'
      ? `PostPlus is ready: ${input.skillCount} official Skills installed and verified (${input.options.scope}).`
      : `PostPlus Skills ${input.outcome === 'repaired' ? 'repaired and verified' : 'updated'}: ${input.skillCount} current, ${input.retiredSkillCount} retired removed (${input.options.scope}).`;
  input.dependencies.reportSuccess?.([summary,
    ...(input.changed ? ['Skills are ready on disk.', session.action!] : []),
    ...(input.backup ? [`Backup saved: ${input.backup.path}.`] : []),
  ].join(' '));
}

class SkillMutationError extends Error {
  readonly stage = 'skills_installation';
  readonly service = 'local';
  readonly retryable = false;
  constructor(readonly code: string, message: string, readonly action: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

async function runSkillInstaller(
  dependencies: SkillMutationDependencies,
  recoveryCommand: string,
  ...args: Parameters<typeof runInteractiveCommand>
): Promise<number> {
  try {
    return await dependencies.runInteractiveCommand(...args);
  } catch (cause) {
    // Preserve lock retention for an installer whose descendants may still run.
    if (cause instanceof CommandInterruptedError || cause instanceof CommandTimeoutError) throw cause;
    throw new SkillMutationError('postplus_skill_install_failed',
      'Skill maintenance could not finish; completed work will be reused.',
      `Resolve the reported installer failure, then run ${recoveryCommand}.`, cause);
  }
}

class SkillReconciliationError extends Error {
  readonly code = 'postplus_skill_reconciliation_failed';
  readonly retryable = false;
  constructor(message: string, readonly action: string) { super(message); }
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

  const backup = await protectLocallyModifiedSkills({
    action: 'uninstall',
    dependencies,
    scope: options.scope,
    yes: options.yes,
    json: options.json,
    targetHashes: catalog.contentHashes,
    managedNames: allKnownSkillNames,
  });

  const exitCode = await runSkillInstaller(dependencies, formatPostPlusSkillUninstallCommand(options.scope),
    process.execPath,
    buildPostPlusSkillUninstallArgs(allKnownSkillNames, options.scope),
    { stdin: 'ignore', stdout: 'capture', timeoutMs: 300_000 },
  );

  if (exitCode !== 0) {
    throw new SkillMutationError('postplus_skill_remove_failed', 'Skill removal failed.', formatPostPlusSkillUninstallCommand(options.scope));
  }

  await verifyPostPlusSkillUninstall({
    dependencies,
    removedSkillNames: allKnownSkillNames,
    scope: options.scope,
  });

  await clearManagedSkillBaseline(options.scope);
  await clearUpdateCheckCache();
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, outcome: 'uninstalled', scope: options.scope, backup })}\n`);
  else dependencies.reportSuccess?.(
    `PostPlus skills uninstalled: ${allKnownSkillNames.length} managed skills removed (${options.scope}). Restart active agent sessions to refresh skill discovery.${backup ? ` Backup saved: ${backup.path}.` : ''}`,
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
    const targetIssues: NonNullable<SkillInstallStatusReport['targetIssues']> = [];
    if (catalog.contentHashes) {
      const hashes = await readInstalledHashes(postPlusInstalled);
      for (const name of requiredSkills) {
        for (const agent of POSTPLUS_SKILLS_AGENT_TARGETS) {
          if (agentDirectoriesMatch(postPlusInstalled, hashes, name, agent, catalog.contentHashes[name]!)) continue;
          if (!missingSkills.includes(name)) missingSkills.push(name);
          targetIssues.push({skill:name,agent,paths:postPlusInstalled.filter(entry=>entry.name===name && entry.agentIds.includes(agent)).map(entry=>entry.path)});
        }
      }
    }
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
          : `This installation has no verified current release. Run ${formatPostPlusSkillsInstallCommand(undefined, scope)} to install and verify the bundled skills.`,
        installCommand: formatPostPlusSkillsInstallCommand(
          catalog.source,
          scope,
        ),
        installedCount: installedNames.size,
        targetIssues,
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
      `[PASS] Skill kinds found: ${report.installedCount}/${report.requiredCount}`,
    );
  } else {
    lines.push(
      `[FAIL] Skill kinds found: ${report.installedCount}/${report.requiredCount}`,
    );
  }

  if (report.ok) lines.push('  All supported targets verified.');
  for (const issue of report.targetIssues ?? []) {
    lines.push(`  Target ${issue.agent} / ${issue.skill}: ${issue.paths.length ? 'content needs attention at ' + issue.paths.join(', ') : 'missing'}`);
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
      `  Missing or unready across supported targets: ${formatSkillList(report.missingSkills, 8)}`,
      `  Fix: ${report.installCommand}`,
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
      `[PASS] Skill kinds found: ${report.installedCount}/${report.requiredCount}`,
    );
  } else {
    lines.push(
      `[FAIL] Skill kinds found: ${report.installedCount}/${report.requiredCount}`,
    );
  }

  if (report.ok) lines.push('  All supported targets verified.');
  for (const issue of report.targetIssues ?? []) {
    lines.push(`  Target ${issue.agent} / ${issue.skill}: ${issue.paths.length ? 'content needs attention at ' + issue.paths.join(', ') : 'missing'}`);
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
      `  Missing or unready across supported targets: ${formatSkillList(report.missingSkills, 8)}`,
      `  Fix: ${report.installCommand}`,
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
    ...SKILLS_INSTALLER_ARGS,
    'add',
    skillsSource,
    ...buildSkillScopeArgs(scope),
    '--full-depth',
    '--skill',
    ...skillNames,
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
    ...SKILLS_INSTALLER_ARGS,
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

function releaseOrder(releaseId: string): number[] | null {
  const match = /^(?:skills-)?(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?(?:-[a-zA-Z0-9._-]+)?$/.exec(releaseId);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)] : null;
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
  action: 'uninstall' | 'update' | 'install';
  dependencies: SkillMutationDependencies;
  scope: PostPlusSkillsInstallScope;
  yes?: boolean;
  json?: boolean;
  targetHashes?: Record<string, string>;
  managedNames?: string[];
}): Promise<SkillBackup | null> {
  const baseline = await readManagedSkillBaseline(input.scope);
  const installed = await listInstalledSkillsForMutationScope(input.dependencies, input.scope);
  const managed = new Set([...baseline.skillNames, ...Object.keys(input.targetHashes ?? {}), ...(input.managedNames ?? [])]);
  const modifiedSkills: ProtectedInstalledSkill[] = [];
  const seen = new Set<string>();
  for (const entry of installed) {
    if (!managed.has(entry.name)) continue;
    const actualContentHash = await readInstalledHash(entry);
    if (actualContentHash === null || seen.has(entry.realPath!)) continue;
    seen.add(entry.realPath!);
    // Target identity wins even if the third-party lock is stale. The previous
    // baseline proves an untouched older official version can be upgraded.
    if (actualContentHash === input.targetHashes?.[entry.name] ||
        actualContentHash === baseline.contentHashes?.[entry.name]) continue;
    const expectedContentHash = baseline.contentHashes?.[entry.name] ?? null;
    modifiedSkills.push({ actualContentHash, expectedContentHash,
      state: expectedContentHash === null ? 'unverified' : 'modified',
      installedPath: entry.path, name: entry.name });
  }

  if (modifiedSkills.length === 0) {
    return null;
  }

  const skillNames = [...new Set(modifiedSkills.map((skill) => skill.name))];
  if (!input.yes && (input.json || input.dependencies.isInteractive?.() !== true)) {
    const retryCommand =
      input.action === 'uninstall'
        ? formatPostPlusSkillUninstallCommand(input.scope)
        : input.action === 'install' ? formatPostPlusSkillsInstallCommand(undefined, input.scope) : formatPostPlusSkillUpdateCommand(input.scope);
    const contentState = modifiedSkills.some(skill => skill.state === 'unverified') ? 'unverified' : 'modified';
    throw new PostPlusFailure(
      `${contentState === 'unverified' ? 'Existing skill content cannot be verified as managed by this CLI version' : 'Managed skill content differs from its recorded baseline'}: ${formatSkillList(skillNames, 8)}. Locations: ${formatSkillList(modifiedSkills.map(skill => skill.installedPath), 8)}.`,
      { code: contentState === 'unverified' ? 'postplus_skills_content_unverified' : 'postplus_skills_requires_human',
        stage: 'skills_content_verification', service: 'local', retryable: false, contentState,
        conflicts: modifiedSkills.map(skill => ({ name: skill.name, path: skill.installedPath, state: skill.state })),
        action: `Ask the user to approve backup and ${input.action === 'uninstall' ? 'removal' : 'replacement'}, then run ${retryCommand} --yes.` });
  }

  const confirmed = input.yes || await (
    input.dependencies.confirmModifiedSkillBackup ??
    confirmModifiedSkillBackup
  )({
    action: input.action,
    scope: input.scope,
    skillNames,
  });

  if (!confirmed) {
    throw new Error(
      `PostPlus skills ${input.action} cancelled before changing existing skill content. Managed baseline was not changed.`,
    );
  }

  const backupPath = await backupModifiedSkills(
    modifiedSkills,
    input.scope,
  );
  return { path: backupPath, skillCount: modifiedSkills.length };
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
      `Local PostPlus content needs approval (${input.scope}): ${formatSkillList(input.skillNames, 8)}\n`,
    );
    const answer = await terminal.question(
      input.action !== 'uninstall'
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
  skills: ProtectedInstalledSkill[],
  scope: PostPlusSkillsInstallScope,
): Promise<string> {
  const backupRoot = join(getPostPlusConfigDir(), 'skill-backups');
  await mkdir(backupRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = await mkdtemp(join(backupRoot, `${timestamp}-`));
  const manifestEntries: Array<
    ProtectedInstalledSkill & { backupPath: string }
  > = [];

  for (const skill of skills) {
    const sourcePath = await realpath(skill.installedPath);
    const skillBackupPath = join(
      backupPath,
      `skill-${manifestEntries.length + 1}-${Buffer.from(skill.name).toString('base64url')}`,
    );
    await cp(sourcePath, skillBackupPath, {
      recursive: true,
      verbatimSymlinks: true,
    });
    if (await hashSkillDirectory(skillBackupPath) !== skill.actualContentHash) {
      throw new SkillMutationError('postplus_skill_backup_changed', 'Skill content changed while its backup was being made.', 'Stop editing the skill, then rerun the requested maintenance command.');
    }
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

async function verifyPostPlusSkillUpdate(input: {
  dependencies: SkillManagementDependencies;
  releasedSkillNames: string[];
  contentHashes?: Record<string, string>;
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

  if (input.contentHashes) {
    const hashes = await readInstalledHashes(installed.filter((entry) => releasedSkills.has(entry.name)));
    for (const name of input.releasedSkillNames) {
      if (POSTPLUS_SKILLS_AGENT_TARGETS.some((agent) => !agentDirectoriesMatch(installed, hashes, name, agent, input.contentHashes![name]!)) && !missingSkills.includes(name)) missingSkills.push(name);
    }
  }
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
    `Run ${formatPostPlusSkillsInstallCommand(undefined, input.scope)} to reconcile the bundled skills.`,
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
    `Run ${formatPostPlusSkillUninstallCommand(input.scope)} to finish removing managed skills.`,
  );
}

function formatSkillReconciliationError(input: {
  action: 'uninstall' | 'update' | 'install';
  missingSkills: string[];
  residualSkills: string[];
  scope: PostPlusSkillsInstallScope;
}): string {
  const details: string[] = [];

  if (input.missingSkills.length > 0) {
    details.push(`missing or unready targets for: ${formatSkillList(input.missingSkills, 8)}`);
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
    process.execPath,
    [...SKILLS_INSTALLER_ARGS, 'list', '--json', ...scopeArgs],
    {
      timeoutMs: 60_000,
    },
  );
  const parsed = JSON.parse(result.stdout) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('`skills list --json` returned an invalid payload.');
  }

  return parsed.flatMap(normalizeInstalledSkillEntry);
}

function normalizeInstalledSkillEntry(value: unknown): InstalledSkillEntry[] {
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

  if (!Array.isArray(record.directories)) {
    throw new SkillMutationError('postplus_skills_installer_abi_invalid',
      'The skills installer did not report actual installation directories.',
      'Reinstall PostPlus CLI from the official package.');
  }
  return record.directories.map((value: unknown) => {
    const directory = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (typeof directory.path !== 'string' || !isAbsolute(directory.path) ||
        (directory.realPath !== null && (typeof directory.realPath !== 'string' || !isAbsolute(directory.realPath))) ||
        typeof directory.directoryName !== 'string' || !directory.directoryName.trim() ||
        (directory.metadataName !== null && typeof directory.metadataName !== 'string') ||
        ![null, 'missing-skill-file', 'invalid-skill-metadata', 'occupied-file', 'dangling-link'].includes(directory.metadataError as null | string) ||
        !Array.isArray(directory.agentIds) || directory.agentIds.some((agent) => typeof agent !== 'string' || !agent.trim())) {
      throw new SkillMutationError('postplus_skills_installer_abi_invalid',
        'The skills installer returned an invalid directory record.',
        'Reinstall PostPlus CLI from the official package.');
    }
    return { agents, name: directory.directoryName, scope, path: directory.path, realPath: directory.realPath as string | null, metadataName: directory.metadataName as string | null, metadataError: directory.metadataError as string | null, agentIds: [...new Set(directory.agentIds as string[])] };
  });
}

async function readInstalledHash(entry: InstalledSkillEntry): Promise<string | null> {
  if (entry.realPath === null || entry.metadataError === 'occupied-file' || entry.metadataError === 'dangling-link') {
    throw new SkillMutationError('postplus_skills_directory_unreadable',
      `The managed skill slot ${entry.name} is occupied by a file or broken link.`,
      'Resolve the occupied skill path before running the command again.');
  }
  try {
    if (await realpath(entry.path) !== entry.realPath) {
      throw new SkillMutationError('postplus_skills_installer_abi_invalid',
        'The reported skill directory identity changed.', 'Run the command again to inspect the current installation.');
    }
    return await hashSkillDirectory(entry.path);
  } catch (error) {
    if (error instanceof UnsupportedSkillEntryError) {
      throw new SkillMutationError('postplus_skills_directory_unreadable',
        `Installed skill content cannot be verified at ${error.path}.`,
        'Move the symbolic link or special file out of the installed skill directory, then rerun the command.');
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readInstalledHashes(installed: InstalledSkillEntry[]): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>();
  for (const entry of installed) hashes.set(entry.path, await readInstalledHash(entry));
  return hashes;
}

function agentDirectoriesMatch(installed: InstalledSkillEntry[], hashes: Map<string, string | null>, name: string, agentId: string, expectedHash: string): boolean {
  const directories = installed.filter((entry) => entry.name === name && entry.agentIds.includes(agentId));
  return directories.length > 0 && directories.every((entry) => hashes.get(entry.path) === expectedHash);
}

function formatSkillList(skills: string[], limit: number): string {
  const visible = skills.slice(0, limit);
  const rest = skills.length - visible.length;

  return rest > 0
    ? `${visible.join(', ')} (+${rest} more)`
    : visible.join(', ');
}
