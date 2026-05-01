import { runCommand } from './command-runner.js';
import {
  type PublicSkillCatalogReport,
  loadPublicSkillCatalog,
} from './skill-catalog.js';

const LOCAL_DEPENDENCY_CHECK_TIMEOUT_MS = 10_000;

export type LocalDependencyCheck = {
  dependency: string;
  ok: boolean;
  detail: string;
  skillIds: string[];
};

export type LocalDependencyReport = {
  ok: boolean;
  revision: string;
  source: string;
  requiredCount: number;
  checks: LocalDependencyCheck[];
};

export type LocalDependencyCommandRunner = (
  command: string,
  args: string[],
) => Promise<void>;

export type LocalDependencyReportOptions = {
  loadCatalog?: () => Promise<PublicSkillCatalogReport>;
  runDependencyCheck?: LocalDependencyCommandRunner;
};

export async function generateLocalDependencyReport(
  options: LocalDependencyReportOptions = {},
): Promise<LocalDependencyReport> {
  const loadCatalog = options.loadCatalog ?? loadPublicSkillCatalog;
  const runDependencyCheck =
    options.runDependencyCheck ?? runLocalDependencyCommand;
  const catalog = await loadCatalog();
  const requirements = collectLocalDependencyRequirements(catalog);
  const checks = await Promise.all(
    requirements.map(({ dependency, skillIds }) =>
      checkLocalDependency(dependency, skillIds, runDependencyCheck),
    ),
  );

  return {
    ok: checks.every((check) => check.ok),
    revision: catalog.revision,
    source: catalog.source,
    requiredCount: checks.length,
    checks,
  };
}

export function formatLocalDependencyReport(
  report: LocalDependencyReport,
): string {
  if (report.requiredCount === 0) {
    return `No local runtime dependencies are required by released PostPlus skills (${report.revision}).`;
  }

  const missing = report.checks.filter((check) => !check.ok);
  if (missing.length === 0) {
    return `Ready (${report.requiredCount} local dependencies present; catalog ${report.revision})`;
  }

  return `Missing ${missing.length}/${report.requiredCount}: ${missing
    .map(
      (check) => `${check.dependency} for ${formatSkillList(check.skillIds)}`,
    )
    .join('; ')}`;
}

function collectLocalDependencyRequirements(catalog: PublicSkillCatalogReport) {
  const dependencyToSkills = new Map<string, Set<string>>();

  for (const skill of catalog.skills) {
    for (const dependency of skill.localDependencies) {
      if (!dependencyToSkills.has(dependency)) {
        dependencyToSkills.set(dependency, new Set());
      }
      dependencyToSkills.get(dependency)?.add(skill.skillId);
    }
  }

  return [...dependencyToSkills.entries()]
    .map(([dependency, skillIds]) => ({
      dependency,
      skillIds: [...skillIds].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.dependency.localeCompare(b.dependency));
}

async function checkLocalDependency(
  dependency: string,
  skillIds: string[],
  runDependencyCheck: LocalDependencyCommandRunner,
): Promise<LocalDependencyCheck> {
  try {
    const command = buildLocalDependencyCommand(dependency);
    await runDependencyCheck(command.command, command.args);
    return {
      dependency,
      ok: true,
      detail: 'available',
      skillIds,
    };
  } catch (error) {
    return {
      dependency,
      ok: false,
      detail:
        error instanceof Error
          ? error.message
          : 'Local dependency check failed.',
      skillIds,
    };
  }
}

function buildLocalDependencyCommand(dependency: string): {
  command: string;
  args: string[];
} {
  const parts = dependency.split(':');
  if (parts.length === 1) {
    return {
      command: dependency,
      args: ['--version'],
    };
  }

  const [runtime, moduleName] = parts;
  if (
    parts.length === 2 &&
    runtime === 'python3' &&
    /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(moduleName)
  ) {
    return {
      command: 'python3',
      args: [
        '-c',
        `import importlib; importlib.import_module(${JSON.stringify(moduleName)})`,
      ],
    };
  }

  throw new Error(`Unsupported local dependency requirement: ${dependency}`);
}

async function runLocalDependencyCommand(
  command: string,
  args: string[],
): Promise<void> {
  await runCommand(command, args, {
    timeoutMs: LOCAL_DEPENDENCY_CHECK_TIMEOUT_MS,
  });
}

function formatSkillList(skillIds: string[]): string {
  if (skillIds.length <= 3) {
    return skillIds.join(', ');
  }

  return `${skillIds.slice(0, 3).join(', ')} +${skillIds.length - 3} more`;
}
