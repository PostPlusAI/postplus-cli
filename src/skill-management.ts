import { runCommand, runInteractiveCommand } from './command-runner.js';
import {
  clearManagedSkillBaseline,
  readManagedSkillBaseline,
  writeManagedSkillBaseline,
} from './local-state.js';
import {
  POSTPLUS_SKILLS_AGENT_TARGETS,
  POSTPLUS_SKILLS_INSTALL_COMMAND,
  POSTPLUS_SKILLS_REPO,
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
  managedRevision: string | null;
  updateCommand: string;
  uninstallCommand: string;
  retiredManagedSkills: string[];
};

type SkillManagementDependencies = {
  runCommand: typeof runCommand;
};

type SkillMutationDependencies = {
  runInteractiveCommand: typeof runInteractiveCommand;
};

export async function runPostPlusSkillUpdate(
  dependencies: SkillMutationDependencies = {
    runInteractiveCommand,
  },
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
    buildPostPlusSkillUpdateArgs(skillNames),
  );

  if (updateExitCode !== 0) {
    return updateExitCode;
  }

  if (retiredSkillNames.length > 0) {
    const removeExitCode = await dependencies.runInteractiveCommand(
      'npx',
      buildPostPlusSkillUninstallArgs(retiredSkillNames),
    );

    if (removeExitCode !== 0) {
      return removeExitCode;
    }
  }

  await writeManagedSkillBaseline({
    revision: catalog.revision,
    skillNames,
  });

  return 0;
}

export async function runPostPlusSkillUninstall(
  dependencies: SkillMutationDependencies = {
    runInteractiveCommand,
  },
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
    buildPostPlusSkillUninstallArgs(allKnownSkillNames),
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
  const catalog = await loadPublicSkillCatalog();
  const requiredSkills = new Set(catalog.skills.map((skill) => skill.skillId));
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
      ok: missingSkills.length === 0,
      error: null,
      installCommand: POSTPLUS_SKILLS_INSTALL_COMMAND,
      installedCount: installedNames.size,
      managedRevision: baseline.revision,
      missingSkills,
      requiredCount: requiredSkills.size,
      retiredManagedSkills,
      scopes,
      source: POSTPLUS_SKILLS_REPO,
      updateCommand: formatPostPlusSkillUpdateCommand(),
      uninstallCommand: formatPostPlusSkillUninstallCommand(),
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to inspect installed PostPlus skills.',
      installCommand: POSTPLUS_SKILLS_INSTALL_COMMAND,
      installedCount: 0,
      managedRevision: baseline.revision,
      missingSkills: [...requiredSkills],
      requiredCount: requiredSkills.size,
      retiredManagedSkills,
      scopes: [],
      source: POSTPLUS_SKILLS_REPO,
      updateCommand: formatPostPlusSkillUpdateCommand(),
      uninstallCommand: formatPostPlusSkillUninstallCommand(),
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
  lines.push(`  Managed baseline: ${report.managedRevision ?? 'none'}`);
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
      `  Fix: ${report.installCommand}`,
    );
  } else {
    lines.push(`  Update: ${report.updateCommand}`);
  }

  return lines.join('\n');
}

export function buildPostPlusSkillUpdateArgs(skillNames: string[]): string[] {
  return [...NPX_SKILLS, 'update', ...skillNames, '--global', '--yes'];
}

export function buildPostPlusSkillUninstallArgs(
  skillNames: string[],
): string[] {
  return [
    ...NPX_SKILLS,
    'remove',
    ...skillNames,
    '--global',
    '--agent',
    ...POSTPLUS_SKILLS_AGENT_TARGETS,
    '--yes',
  ];
}

export function formatPostPlusSkillUpdateCommand(): string {
  return 'postplus update';
}

export function formatPostPlusSkillUninstallCommand(): string {
  return 'postplus uninstall';
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
