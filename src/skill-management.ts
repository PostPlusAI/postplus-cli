import {
  POSTPLUS_SKILLS_INSTALL_COMMAND,
  POSTPLUS_SKILLS_REPO,
  loadPublicSkillCatalog,
} from './skill-catalog.js';
import { runCommand, runInteractiveCommand } from './command-runner.js';

const SKILLS_AGENTS = ['claude-code', 'codex', 'cursor'];
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
  updateCommand: string;
  uninstallCommand: string;
};

type SkillManagementDependencies = {
  runCommand: typeof runCommand;
};

export async function runPostPlusSkillInstall(): Promise<number> {
  return runInteractiveCommand('npx', buildPostPlusSkillInstallArgs());
}

export async function runPostPlusSkillUpdate(): Promise<number> {
  const catalog = await loadPublicSkillCatalog();
  const skillNames = catalog.skills.map((skill) => skill.skillId);

  if (skillNames.length === 0) {
    throw new Error('PostPlus public skill catalog has no released skills.');
  }

  return runInteractiveCommand('npx', buildPostPlusSkillUpdateArgs(skillNames));
}

export async function runPostPlusSkillUninstall(): Promise<number> {
  const catalog = await loadPublicSkillCatalog();
  const skillNames = catalog.skills.map((skill) => skill.skillId);

  if (skillNames.length === 0) {
    throw new Error('PostPlus public skill catalog has no released skills.');
  }

  return runInteractiveCommand(
    'npx',
    buildPostPlusSkillUninstallArgs(skillNames),
  );
}

export async function generateSkillInstallStatusReport(
  dependencies: SkillManagementDependencies = {
    runCommand,
  },
): Promise<SkillInstallStatusReport> {
  const catalog = await loadPublicSkillCatalog();
  const requiredSkills = new Set(catalog.skills.map((skill) => skill.skillId));

  try {
    const installed = await listInstalledSkills(dependencies);
    const postPlusInstalled = installed.filter((skill) =>
      requiredSkills.has(skill.name),
    );
    const installedNames = new Set(postPlusInstalled.map((skill) => skill.name));
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
      missingSkills,
      requiredCount: requiredSkills.size,
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
      missingSkills: [...requiredSkills],
      requiredCount: requiredSkills.size,
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
  lines.push(
    `  Scope: ${report.scopes.length > 0 ? report.scopes.join(', ') : 'none detected'}`,
  );

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

export function buildPostPlusSkillInstallArgs(): string[] {
  return [
    ...NPX_SKILLS,
    'add',
    POSTPLUS_SKILLS_REPO,
    '--full-depth',
    '--skill',
    '*',
    '--agent',
    ...SKILLS_AGENTS,
    '--yes',
  ];
}

export function buildPostPlusSkillUpdateArgs(skillNames: string[]): string[] {
  return [...NPX_SKILLS, 'update', ...skillNames, '--yes'];
}

export function buildPostPlusSkillUninstallArgs(skillNames: string[]): string[] {
  return [
    ...NPX_SKILLS,
    'remove',
    ...skillNames,
    '--agent',
    ...SKILLS_AGENTS,
    '--yes',
  ];
}

export function formatPostPlusSkillUpdateCommand(): string {
  return 'postplus update';
}

export function formatPostPlusSkillUninstallCommand(): string {
  return 'postplus uninstall';
}

async function listInstalledSkills(
  dependencies: SkillManagementDependencies,
): Promise<InstalledSkillEntry[]> {
  const [project, global] = await Promise.all([
    listInstalledSkillsForScope(dependencies, []),
    listInstalledSkillsForScope(dependencies, ['--global']),
  ]);
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

  return rest > 0 ? `${visible.join(', ')} (+${rest} more)` : visible.join(', ');
}
