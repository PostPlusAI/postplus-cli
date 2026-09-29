import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { formatSkillDiscovery } from './skill-discovery.js';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

import { hashSkillDirectory, SkillsBundleError, UnsupportedSkillEntryError } from './skills-bundle.js';

export const POSTPLUS_SKILLS_SESSION_ACTION = 'Start a new agent session in the same project. If you already have a task, paste the original request and say: "PostPlus is installed or updated; continue this task." Otherwise, describe the task you want to complete.';

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
  reportSuccess?: (message: string) => void;
  runCommand: typeof runCommand;
  runInteractiveCommand: typeof runInteractiveCommand;
};

type SkillMutationOptions = {
  command?: 'install' | 'update';
  json?: boolean;
  messageMode?: 'explicit' | 'implicit';
  scope: PostPlusSkillsInstallScope;
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
  let installed = await listInstalledSkillsForMutationScope(dependencies, options.scope);
  const firstInstall = baseline.releaseId === null && baseline.skillNames.length === 0 && lockedSkillNames.length === 0 && !installed.some(entry => releasedSkills.has(entry.name));
  let hashes = await readInstalledHashes(installed.filter((entry) => releasedSkills.has(entry.name)));
  const baselineIsCurrent = !shouldRepairManagedBaseline({ baseline, releaseId: catalog.releaseId, skillNames });
  const targets: string[] = [];
  // Replace the whole slot, including old independent copies that the current
  // installer now routes through a shared directory. No old-content identity is needed.
  const replacements = installed.filter(entry => retiredSkillNames.includes(entry.name) ||
    (releasedSkills.has(entry.name) && hashes.get(entry.path) !== catalog.contentHashes![entry.name]));
  await assertPostPlusSkillsBaselineWritable(options.scope);
  if (replacements.length > 0 || retiredSkillNames.length > 0) {
    await removeInstalledSkillPaths(replacements, retiredSkillNames, dependencies, options.scope);
    installed = await listInstalledSkillsForMutationScope(dependencies, options.scope);
    hashes = await readInstalledHashes(installed.filter(entry => releasedSkills.has(entry.name)));
  }
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

  await verifyPostPlusSkillUpdate({
    dependencies,
    releasedSkillNames: skillNames,
    contentHashes: catalog.contentHashes,
    retiredSkillNames,
    scope: options.scope,
  });

  if (targets.length === 0 && replacements.length === 0 && retiredSkillNames.length === 0 && baselineIsCurrent) {
    reportPostPlusSkillReconcileSuccess({ catalog, dependencies, options, outcome: 'current', retiredSkillCount: 0, skillCount: skillNames.length, changed: false });
    return 0;
  }

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
    outcome: targets.length === 0 && replacements.length === 0 && retiredSkillNames.length === 0 && baselineIsCurrent ? 'current' :
      baseline.releaseId === null && lockedSkillNames.length === 0
        ? 'ready'
        : baseline.releaseId === catalog.releaseId
          ? 'repaired'
          : 'updated',
    options,
    firstInstall,
    previousReleaseId: baseline.releaseId,
    retiredSkillCount: retiredSkillNames.length,
    skillCount: skillNames.length,
    changed: targets.length > 0 || replacements.length > 0,
  });

  return 0;
}

// Directory rules remain owned by the bundled installer. It re-enumerates and
// validates every exact path before deletion; links never authorize their targets.
async function removeInstalledSkillPaths(
  installed: InstalledSkillEntry[], retiredNames: string[],
  dependencies: SkillMutationDependencies, scope: PostPlusSkillsInstallScope,
  recoveryCommand = formatPostPlusSkillsInstallCommand(undefined, scope),
): Promise<void> {
  await mkdir(getPostPlusConfigDir(), { recursive: true });
  const directory = await mkdtemp(join(getPostPlusConfigDir(), 'skills-sync-'));
  const planPath = join(directory, 'manifest.json');
  try {
    await writeFile(planPath, JSON.stringify({ schemaVersion: 2, scope,
      names: mergeSkillNames(installed.map(entry => entry.name), retiredNames),
      entries: installed.map(({ name, path, realPath }) => ({ name, path, realPath })),
    }), { mode: 0o600 });
    const code = await runSkillInstaller(dependencies, recoveryCommand,
      process.execPath, [...SKILLS_INSTALLER_ARGS, 'remove', '--postplus-remove-plan', planPath],
      { stdin: 'ignore', stdout: 'capture', timeoutMs: 300_000 });
    if (code !== 0) throw new SkillMutationError('postplus_skill_remove_failed',
      'PostPlus could not remove skill files.', recoveryCommand);
  } finally {
    await rm(dirname(planPath), { recursive: true, force: true });
  }
}

function reportPostPlusSkillReconcileSuccess(input: {
  catalog: Awaited<ReturnType<typeof loadPublicSkillCatalog>>;
  dependencies: SkillMutationDependencies;
  options: SkillMutationOptions;
  outcome: 'current' | 'ready' | 'repaired' | 'updated';
  firstInstall?: boolean;
  previousReleaseId?: string | null;
  retiredSkillCount: number;
  skillCount: number;
  changed: boolean;
}): void {
  const session = { newSessionRequired: input.changed,
    action: input.changed ? POSTPLUS_SKILLS_SESSION_ACTION : null };
  const introduction = input.firstInstall && input.outcome === 'ready' && input.options.command === 'install'
    ? { paragraphs: input.catalog.productBrief?.paragraphs ?? [],
        capabilities: Object.entries(input.catalog.categories ?? {}).filter(([id]) => id !== 'workspace').flatMap(([id, category]) => {
          const example = input.catalog.skills.find(skill => skill.category === id && skill.example)?.example;
          return example ? [{ title: category.title, example }] : [];
        }).slice(0, 6) }
    : undefined;
  const releaseNotes = input.outcome === 'updated' && input.previousReleaseId && input.previousReleaseId !== input.catalog.releaseId ? input.catalog.releaseNotes : undefined;
  if (input.options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, outcome: input.outcome, releaseId: input.catalog.releaseId,
      skillCount: input.skillCount, retiredSkillCount: input.retiredSkillCount, scope: input.options.scope,
      diskReady: true, changed: input.changed, session,
      ...(introduction ? { introduction } : {}), ...(releaseNotes ? { releaseNotes } : {}) })}\n`);
    return;
  }
  const summary = input.outcome === 'current'
    ? `PostPlus is already current: ${input.skillCount} official Skills verified (${input.options.scope}).`
    : input.outcome === 'ready'
      ? `PostPlus is ready: ${input.skillCount} official Skills installed and verified (${input.options.scope}).`
      : `PostPlus Skills ${input.outcome === 'repaired' ? 'repaired and verified' : 'updated'}: ${input.skillCount} current, ${input.retiredSkillCount} retired removed (${input.options.scope}).`;
  input.dependencies.reportSuccess?.([summary,
    ...(input.changed ? ['Skills are ready on disk.', session.action!] : []),
  ].join(' ') + (introduction
    ? `\n\n${[...introduction.paragraphs, formatSkillDiscovery(input.catalog, 'summary')].join('\n\n')}` : '') +
    (releaseNotes ? `\n\n${releaseNotes.title}\n${releaseNotes.summary}\n${releaseNotes.highlights.map(item => `- ${item}`).join('\n')}` : ''));
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

  const installed = (await listInstalledSkillsForMutationScope(dependencies, options.scope))
    .filter(entry => allKnownSkillNames.includes(entry.name));
  await removeInstalledSkillPaths(installed, allKnownSkillNames, dependencies, options.scope,
    formatPostPlusSkillUninstallCommand(options.scope));

  await verifyPostPlusSkillUninstall({
    dependencies,
    removedSkillNames: allKnownSkillNames,
    scope: options.scope,
  });

  await clearManagedSkillBaseline(options.scope);
  await clearUpdateCheckCache();
  if (options.json) process.stdout.write(`${JSON.stringify({ ok: true, outcome: 'uninstalled', scope: options.scope })}\n`);
  else dependencies.reportSuccess?.(
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
    return null;
  }
  try {
    if (await realpath(entry.path) !== entry.realPath) {
      throw new SkillMutationError('postplus_skills_installer_abi_invalid',
        'The reported skill directory identity changed.', 'Run the command again to inspect the current installation.');
    }
    return await hashSkillDirectory(entry.path);
  } catch (error) {
    if (error instanceof UnsupportedSkillEntryError) return null;
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
