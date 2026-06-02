import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeCurrentCliVersionToLocalConfig } from './client-compatibility.js';
import { runCommand, runInteractiveCommand } from './command-runner.js';
import {
  clearManagedSkillBaseline,
  readManagedSkillBaseline,
  writeManagedSkillBaseline,
} from './local-state.js';
import {
  POSTPLUS_SKILLS_AGENT_TARGETS,
  type PostPlusSkillsInstallScope,
  formatPostPlusSkillsInstallCommand,
  resolvePostPlusSkillsSource,
  loadPublicSkillCatalog,
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
  runInteractiveCommand: typeof runInteractiveCommand;
};

type SkillMutationOptions = {
  scope: PostPlusSkillsInstallScope;
};

type PostPlusInstallerLockedSkillEntry = {
  name: string;
  scope: 'global' | 'project';
};

const DEFAULT_SKILL_MUTATION_OPTIONS: SkillMutationOptions = {
  scope: 'global',
};

export async function runPostPlusSkillUpdate(
  dependencies: SkillMutationDependencies = {
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
    for (const agentTarget of POSTPLUS_SKILLS_AGENT_TARGETS) {
      const removeExitCode = await dependencies.runInteractiveCommand(
        'npx',
        buildPostPlusSkillUninstallArgs(
          retiredSkillNames,
          options.scope,
          agentTarget,
        ),
      );

      if (removeExitCode !== 0) {
        return removeExitCode;
      }
    }
  }

  await writeManagedSkillBaseline({
    releaseId: catalog.releaseId,
    skillNames,
  });
  await writeCurrentCliVersionToLocalConfig();
  await clearUpdateCheckCache();

  return 0;
}

export async function runPostPlusSkillUninstall(
  dependencies: SkillMutationDependencies = {
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

  for (const agentTarget of POSTPLUS_SKILLS_AGENT_TARGETS) {
    const exitCode = await dependencies.runInteractiveCommand(
      'npx',
      buildPostPlusSkillUninstallArgs(
        allKnownSkillNames,
        options.scope,
        agentTarget,
      ),
    );

    if (exitCode !== 0) {
      return exitCode;
    }
  }

  await clearManagedSkillBaseline();
  await clearUpdateCheckCache();

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
  agentTarget?: (typeof POSTPLUS_SKILLS_AGENT_TARGETS)[number],
): string[] {
  return [
    ...NPX_SKILLS,
    'remove',
    ...skillNames,
    ...buildSkillScopeArgs(scope),
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
        (skillNames) =>
          skillNames.map((name) => ({
            name,
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
): Promise<string[]> {
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
      .map(([skillName]) => skillName.trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function isPostPlusSkillsInstallerLockEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }

  const record = entry as Record<string, unknown>;
  const source =
    typeof record.source === 'string' ? record.source.trim() : '';
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
  } else if (/^https?:\/\//i.test(normalized) || /^ssh:\/\//i.test(normalized)) {
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
