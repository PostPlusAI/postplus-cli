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
  runInteractiveCommand: typeof runInteractiveCommand;
};

type SkillMutationOptions = {
  scope: PostPlusSkillsInstallScope;
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
  const baseline = await readManagedSkillBaseline();
  const retiredSkillNames = baseline.skillNames.filter(
    (skillName) => !skillNames.includes(skillName),
  );

  if (skillNames.length === 0) {
    throw new Error('PostPlus public skill catalog has no released skills.');
  }

  const updateExitCode = await dependencies.runInteractiveCommand(
    'npx',
    buildPostPlusSkillUpdateArgs(skillNames, options.scope),
  );

  if (updateExitCode !== 0) {
    return updateExitCode;
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

  await writeManagedSkillBaseline({
    releaseId: catalog.releaseId,
    skillNames,
  });
  await writeCurrentCliVersionToLocalConfig();

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
  const allKnownSkillNames = mergeSkillNames(skillNames, baseline.skillNames);

  if (allKnownSkillNames.length === 0) {
    throw new Error('PostPlus public skill catalog has no released skills.');
  }

  const exitCode = await dependencies.runInteractiveCommand(
    'npx',
    buildPostPlusSkillUninstallArgs(allKnownSkillNames, options.scope),
  );

  if (exitCode === 0) {
    await clearManagedSkillBaseline();
  }

  return exitCode;
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

  await writeManagedSkillBaseline({
    releaseId: inspection.catalog.releaseId,
    skillNames: inspection.requiredSkillNames,
  });
  await writeCurrentCliVersionToLocalConfig();

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
): Promise<{
  catalog: Awaited<ReturnType<typeof loadPublicSkillCatalog>>;
  report: SkillInstallStatusReport;
  requiredSkillNames: string[];
}> {
  const catalog = await loadPublicSkillCatalog();
  const requiredSkillNames = catalog.skills.map((skill) => skill.skillId);
  const requiredSkills = new Set(requiredSkillNames);
  const baseline = await readManagedSkillBaseline();
  const retiredManagedSkills = baseline.skillNames.filter(
    (skillName) => !requiredSkills.has(skillName),
  );

  try {
    const installed = await listInstalledSkills(dependencies);
    const postPlusInstalled = installed.filter((skill) =>
      requiredSkills.has(skill.name),
    );
    const installedNames = new Set(
      postPlusInstalled.map((skill) => skill.name),
    );
    const missingSkills = [...requiredSkills].filter(
      (skill) => !installedNames.has(skill),
    );
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
        ok: missingSkills.length === 0,
        error: null,
        installCommand: formatPostPlusSkillsInstallCommand(catalog.source),
        installedCount: installedNames.size,
        managedSkillsReleaseId: baseline.releaseId,
        missingSkills,
        requiredCount: requiredSkills.size,
        retiredManagedSkills,
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
        retiredManagedSkills,
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
    ...POSTPLUS_SKILLS_AGENT_TARGETS,
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
    '--agent',
    ...POSTPLUS_SKILLS_AGENT_TARGETS,
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
