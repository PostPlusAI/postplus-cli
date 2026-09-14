import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import {
  POSTPLUS_CLI_UPDATE_COMMAND,
  POSTPLUS_UPDATE_COMMAND,
  type PostPlusClientUpgradePayload,
  readCurrentCliVersion,
} from './client-compatibility.js';
import {
  runCommand as runDefaultCommand,
  runInteractiveCommand as runDefaultInteractiveCommand,
} from './command-runner.js';
import {
  getPostPlusConfigDir,
  readManagedSkillBaseline,
  withPostPlusUpdateLock,
} from './local-state.js';
import {
  POSTPLUS_SKILLS_REPO,
  loadPublicSkillCatalog,
} from './skill-catalog.js';

const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_CACHE_FILE = 'update-check.json';
const NPM_PACKAGE_NAME = '@postplus/cli';
const POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION =
  'POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION';
export const POSTPLUS_CLIENT_RECOVERY_ATTEMPT_ENV =
  'POSTPLUS_CLIENT_RECOVERY_ATTEMPT';
export const POSTPLUS_CLIENT_RECOVERY_COMPONENTS_ENV =
  'POSTPLUS_CLIENT_RECOVERY_COMPONENTS';

export type PostPlusUpdatePlan = {
  cli: boolean;
  implicitRecovery: boolean;
  skills: boolean;
};

export type UpdateStatusReport = {
  checkedAt: string | null;
  ok: boolean;
  source: 'cache' | 'remote' | 'unavailable';
  cli: {
    currentVersion: string;
    latestVersion: string | null;
    updateAvailable: boolean;
    updateCommand: string;
  };
  skills: {
    currentReleaseId: string | null;
    latestReleaseId: string | null;
    updateAvailable: boolean;
    updateCommand: string;
  };
  warning: string | null;
};

type UpdateCheckCache = {
  checkedAt: string;
  cli: {
    currentVersion: string;
    latestVersion: string;
    registryIdentity: string;
  };
  skills: {
    latestReleaseId: string;
  };
};

type UpdateCheckDependencies = {
  fetchFn: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  runCommand?: typeof runDefaultCommand;
};

export type CliSelfUpdateResult = {
  command: typeof POSTPLUS_CLI_UPDATE_COMMAND;
  currentVersion: string;
  exitCode: number | null;
  latestVersion: string;
  updateAvailable: boolean;
};

export type ClientUpgradeRecoveryResult = {
  attempted: boolean;
  exitCode: number;
  restartAgentSessionRequired: boolean;
  updateExitCode: number | null;
};

export function resolvePostPlusUpdatePlan(
  environment: NodeJS.ProcessEnv = process.env,
): PostPlusUpdatePlan {
  const components =
    environment[POSTPLUS_CLIENT_RECOVERY_COMPONENTS_ENV]?.trim();

  return {
    cli: components !== 'skills',
    implicitRecovery: environment[POSTPLUS_CLIENT_RECOVERY_ATTEMPT_ENV] === '1',
    skills: components !== 'cli',
  };
}

/**
 * Recovers one hosted command rejected by the server-side compatibility gate.
 * That gate runs before billing/provider execution, so one update followed by
 * one retry cannot duplicate a hosted side effect. The child retry carries a
 * process guard: a second compatibility rejection stops instead of looping.
 */
export async function runPostPlusClientUpgradeRecovery(
  input: {
    originalArgs: string[];
    payload: PostPlusClientUpgradePayload;
  },
  dependencies: {
    environment?: NodeJS.ProcessEnv;
    runInteractiveCommand?: typeof runDefaultInteractiveCommand;
    writeError?: (message: string) => void;
    writeOutput?: (message: string) => void;
  } = {},
): Promise<ClientUpgradeRecoveryResult> {
  const environment = dependencies.environment ?? process.env;
  const runInteractiveCommand =
    dependencies.runInteractiveCommand ?? runDefaultInteractiveCommand;
  const writeOutput =
    dependencies.writeOutput ?? ((message) => process.stdout.write(message));
  const writeError =
    dependencies.writeError ?? ((message) => process.stderr.write(message));

  if (environment[POSTPLUS_CLIENT_RECOVERY_ATTEMPT_ENV] === '1') {
    writeError(
      'PostPlus is still incompatible after one automatic update and retry. The command was not retried again.\n',
    );
    return {
      attempted: false,
      exitCode: 1,
      restartAgentSessionRequired: false,
      updateExitCode: null,
    };
  }

  const components = resolveRequiredUpdateComponents(input.payload);

  const recoveryEnvironment = {
    ...environment,
    [POSTPLUS_CLIENT_RECOVERY_ATTEMPT_ENV]: '1',
    [POSTPLUS_CLIENT_RECOVERY_COMPONENTS_ENV]: components,
  };
  writeOutput(
    'PostPlus is updating. The current task can resume only if the update succeeds and no agent restart is required.\n',
  );

  const updateExitCode = await runInteractiveCommand('postplus', ['update'], {
    env: recoveryEnvironment,
  });
  if (updateExitCode !== 0) {
    writeError(
      `PostPlus automatic update failed with exit code ${updateExitCode}. The original command was not retried.\n`,
    );
    return {
      attempted: true,
      exitCode: updateExitCode,
      restartAgentSessionRequired: false,
      updateExitCode,
    };
  }

  if (input.payload.compatibility?.upgrade?.restartAgentSession === true) {
    writeError(
      'PostPlus updated successfully, but this compatibility change requires a new agent session. The original command was not retried.\n',
    );
    return {
      attempted: true,
      exitCode: 1,
      restartAgentSessionRequired: true,
      updateExitCode,
    };
  }

  const retryExitCode = await runInteractiveCommand(
    'postplus',
    input.originalArgs,
    { env: recoveryEnvironment },
  );

  return {
    attempted: true,
    exitCode: retryExitCode,
    restartAgentSessionRequired: false,
    updateExitCode,
  };
}

function resolveRequiredUpdateComponents(
  payload: PostPlusClientUpgradePayload,
): 'all' | 'cli' | 'skills' {
  const cliRequired = payload.compatibility?.upgrade?.cli?.required === true;
  const skillsRequired =
    payload.compatibility?.upgrade?.skills?.required === true;

  if (cliRequired && !skillsRequired) {
    return 'cli';
  }
  if (skillsRequired && !cliRequired) {
    return 'skills';
  }
  return 'all';
}

export async function generateUpdateStatusReport(
  input: {
    force?: boolean;
  } = {},
  dependencies: UpdateCheckDependencies = {
    fetchFn: fetch,
  },
): Promise<UpdateStatusReport> {
  const currentVersion = await readCurrentCliVersion();
  const managedSkillBaseline = await readManagedSkillBaseline();
  const cache = await readUpdateCheckCache();
  const environment = dependencies.environment ?? process.env;
  const runCommand = dependencies.runCommand ?? runDefaultCommand;
  let matchingCache: UpdateCheckCache | null = null;

  try {
    const registryIdentity = await readNpmRegistryIdentity(
      runCommand,
      environment,
    );
    // Revalidate the effective source even for cache hits. Legacy caches, a
    // changed scope/default registry, or a failed config query cannot establish
    // which distribution the previous version belongs to.
    if (
      cache?.cli.registryIdentity === registryIdentity &&
      cache.cli.currentVersion === currentVersion
    ) {
      matchingCache = cache;
    }
    if (
      matchingCache &&
      !input.force &&
      Date.now() - Date.parse(matchingCache.checkedAt) < UPDATE_CHECK_TTL_MS
    ) {
      return buildUpdateReport({
        cache: matchingCache,
        currentVersion,
        currentSkillsReleaseId: managedSkillBaseline.releaseId,
        source: 'cache',
      });
    }
    const [latestCliVersion, latestSkillsReleaseId] = await Promise.all([
      fetchLatestCliVersion(runCommand, environment),
      fetchLatestSkillReleaseId(dependencies.fetchFn),
    ]);
    const nextCache = {
      checkedAt: new Date().toISOString(),
      cli: {
        currentVersion,
        latestVersion: latestCliVersion,
        registryIdentity,
      },
      skills: {
        latestReleaseId: latestSkillsReleaseId,
      },
    };
    await writeUpdateCheckCache(nextCache);

    return buildUpdateReport({
      cache: nextCache,
      currentVersion,
      currentSkillsReleaseId: managedSkillBaseline.releaseId,
      source: 'remote',
    });
  } catch (error) {
    const warning =
      error instanceof Error ? error.message : 'Update check failed.';

    if (matchingCache) {
      return {
        ...buildUpdateReport({
          cache: matchingCache,
          currentVersion,
          currentSkillsReleaseId: managedSkillBaseline.releaseId,
          source: 'cache',
        }),
        warning,
      };
    }

    return {
      checkedAt: null,
      ok: true,
      source: 'unavailable',
      cli: {
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        updateCommand: POSTPLUS_UPDATE_COMMAND,
      },
      skills: {
        currentReleaseId: managedSkillBaseline.releaseId,
        latestReleaseId: null,
        updateAvailable: false,
        updateCommand: POSTPLUS_UPDATE_COMMAND,
      },
      warning,
    };
  }
}

export async function refreshUpdateCheckCache(): Promise<void> {
  await generateUpdateStatusReport({
    force: true,
  });
}

export async function clearUpdateCheckCache(): Promise<void> {
  await rm(getUpdateCheckCachePath(), {
    force: true,
  });
}

export async function runCliSelfUpdateIfOutdated(
  dependencies: {
    continuationArgs?: string[];
    currentCliEntryPath?: string;
    environment?: NodeJS.ProcessEnv;
    quiet?: boolean;
    runCommand?: typeof runDefaultCommand;
    runInteractiveCommand?: typeof runDefaultInteractiveCommand;
    writeOutput?: (message: string) => void;
  } = {},
): Promise<CliSelfUpdateResult> {
  const runInteractiveCommand =
    dependencies.runInteractiveCommand ?? runDefaultInteractiveCommand;
  const writeOutput =
    dependencies.writeOutput ?? ((message) => process.stdout.write(message));
  const environment = dependencies.environment ?? process.env;
  const quiet = dependencies.quiet === true;
  const currentVersion = await readCurrentCliVersion();
  const continuationVersion =
    environment[POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION]?.trim();

  if (continuationVersion) {
    if (compareVersions(currentVersion, continuationVersion) < 0) {
      throw new Error(
        `PostPlus CLI self-update reported ${continuationVersion}, but the continuation process is still ${currentVersion}.`,
      );
    }

    return {
      command: POSTPLUS_CLI_UPDATE_COMMAND,
      currentVersion,
      exitCode: null,
      latestVersion: continuationVersion,
      updateAvailable: false,
    };
  }

  const latestVersion = await fetchLatestCliVersion(
    dependencies.runCommand ?? runDefaultCommand,
    environment,
  );

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return {
      command: POSTPLUS_CLI_UPDATE_COMMAND,
      currentVersion,
      exitCode: null,
      latestVersion,
      updateAvailable: false,
    };
  }

  const { installationRoot, cliEntryPath } = await resolveCliUpdateInstallation(
    {
      currentCliEntryPath: dependencies.currentCliEntryPath ?? process.argv[1],
      environment,
      runCommand: dependencies.runCommand,
    },
  );

  if (!quiet) {
    writeOutput(
      [
        `PostPlus CLI ${currentVersion} is older than latest ${latestVersion}.`,
        `Updating CLI: ${POSTPLUS_CLI_UPDATE_COMMAND}`,
        '',
      ].join('\n'),
    );
  }

  return await withPostPlusUpdateLock(
    async () => {
      // Another updater may have completed while we waited. Read the installed
      // package under the target lock rather than replacing it a second time.
      const installed = JSON.parse(
        await readFile(
          join(installationRoot, '@postplus/cli/package.json'),
          'utf8',
        ),
      ) as { version?: unknown };
      if (typeof installed.version !== 'string' || !installed.version.trim()) {
        throw new Error(
          'The installed PostPlus CLI has no valid version. No installation was changed.',
        );
      }
      const needsInstall =
        compareVersions(installed.version, latestVersion) < 0;
      const exitCode = needsInstall
        ? await runInteractiveCommand(
            'npm',
            ['install', '-g', `${NPM_PACKAGE_NAME}@${latestVersion}`],
            {
              env: environment,
            },
          )
        : 0;
      if (exitCode !== 0) {
        writeOutput(
          `PostPlus CLI update failed with exit code ${exitCode}. Fix the npm install error, then rerun: ${POSTPLUS_UPDATE_COMMAND}\n`,
        );
        return {
          command: POSTPLUS_CLI_UPDATE_COMMAND,
          currentVersion,
          exitCode,
          latestVersion,
          updateAvailable: true,
        };
      }
      writeOutput(
        needsInstall
          ? 'npm installation finished. Verifying the installed CLI before continuing.\n'
          : 'Another update completed. Verifying the installed CLI before continuing.\n',
      );

      // Keep the package stable until the fresh CLI has finished its continuation.
      // Its version guard skips self-update, so it does not acquire this lock again.
      const continuationExitCode = await runInteractiveCommand(
        process.execPath,
        [cliEntryPath, 'update', ...(dependencies.continuationArgs ?? [])],
        {
          env: {
            ...environment,
            [POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION]: latestVersion,
          },
        },
      );

      return {
        command: POSTPLUS_CLI_UPDATE_COMMAND,
        currentVersion,
        exitCode: continuationExitCode,
        latestVersion,
        updateAvailable: true,
      };
    },
    { installationRoot },
  );
}

export async function resolveCliUpdateInstallation(input: {
  currentCliEntryPath: string | undefined;
  environment: NodeJS.ProcessEnv;
  runCommand?: typeof runDefaultCommand;
}): Promise<{ installationRoot: string; cliEntryPath: string }> {
  if (!input.currentCliEntryPath) {
    throw new Error(
      'PostPlus cannot determine the running CLI entry. No installation was changed.',
    );
  }

  const runCommand = input.runCommand ?? runDefaultCommand;
  const result = await runCommand('npm', ['root', '-g'], {
    env: input.environment,
  });
  const npmRoot = result.stdout.trim();
  if (!isAbsolute(npmRoot) || /[\r\n]/u.test(npmRoot)) {
    throw new Error(
      'npm did not return a single absolute global installation directory. No installation was changed.',
    );
  }

  let installationRoot: string;
  let cliEntryPath: string;
  try {
    installationRoot = await realpath(npmRoot);
    cliEntryPath = await realpath(input.currentCliEntryPath);
    if (
      !(await stat(installationRoot)).isDirectory() ||
      !(await stat(cliEntryPath)).isFile()
    ) {
      throw new Error(
        'Expected an installation directory and a CLI entry file.',
      );
    }
  } catch (cause) {
    throw new Error(
      'PostPlus could not verify the npm installation directory and running CLI entry. No installation was changed.',
      { cause },
    );
  }

  // Resolve the entry and root, not the package directory: npm-linked packages
  // outside this installation must not authorize overwriting a different target.
  const packageRoot = join(installationRoot, '@postplus', 'cli');
  const entryRelativePath = relative(packageRoot, cliEntryPath);
  if (
    !entryRelativePath ||
    entryRelativePath === '..' ||
    entryRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(entryRelativePath)
  ) {
    throw new Error(
      'The running PostPlus CLI does not belong to the selected npm global installation. Use the npm environment that installed this CLI, then retry. No installation was changed.',
    );
  }

  return { installationRoot, cliEntryPath };
}

export function formatUpdateStatusReport(report: UpdateStatusReport): string {
  const lines = ['PostPlus update status', ''];

  const cliMarker = report.cli.updateAvailable ? '[WARN]' : '[PASS]';
  lines.push(
    `${cliMarker} CLI: ${report.cli.currentVersion}${
      report.cli.latestVersion ? ` (latest ${report.cli.latestVersion})` : ''
    }`,
  );
  const skillMarker = report.skills.updateAvailable ? '[WARN]' : '[PASS]';
  lines.push(
    `${skillMarker} Skills: ${
      report.skills.latestReleaseId
        ? `release ${shortReleaseId(report.skills.latestReleaseId)}`
        : 'release unknown'
    }`,
  );
  const updateCommands = [
    report.cli.updateAvailable ? report.cli.updateCommand : null,
    report.skills.updateAvailable ? report.skills.updateCommand : null,
  ].filter((command): command is string => command !== null);

  for (const command of new Set(updateCommands)) {
    lines.push(`  Update: ${command}`);
  }

  lines.push(
    `  Checked: ${report.checkedAt ?? 'not checked'} (${report.source})`,
  );

  if (report.warning) {
    lines.push(`  Warning: ${report.warning}`);
  }

  return lines.join('\n');
}

function buildUpdateReport(input: {
  cache: UpdateCheckCache;
  currentVersion: string;
  currentSkillsReleaseId: string | null;
  source: 'cache' | 'remote';
}): UpdateStatusReport {
  return {
    checkedAt: input.cache.checkedAt,
    ok: true,
    source: input.source,
    cli: {
      currentVersion: input.currentVersion,
      latestVersion: input.cache.cli.latestVersion,
      updateAvailable:
        compareVersions(input.cache.cli.latestVersion, input.currentVersion) >
        0,
      updateCommand: POSTPLUS_UPDATE_COMMAND,
    },
    skills: {
      currentReleaseId: input.currentSkillsReleaseId,
      latestReleaseId: input.cache.skills.latestReleaseId,
      updateAvailable:
        input.cache.skills.latestReleaseId !== input.currentSkillsReleaseId,
      updateCommand: POSTPLUS_UPDATE_COMMAND,
    },
    warning: null,
  };
}

async function fetchLatestCliVersion(
  runCommand: typeof runDefaultCommand,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  let stdout: string;
  try {
    // Global mode must match installation: a project's .npmrc must not change
    // the distribution selected for a global CLI installation.
    ({ stdout } = await runCommand(
      'npm',
      ['view', '--global', `${NPM_PACKAGE_NAME}@latest`, 'version', '--json'],
      { env: environment, timeoutMs: 15_000 },
    ));
  } catch {
    // npm stderr can contain private registry URLs or credentials.
    throw new Error(
      'Failed to check latest PostPlus CLI version with npm. No installation was changed.',
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error('NPM returned an invalid PostPlus CLI version payload.');
  }
  if (
    typeof payload !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
      payload,
    )
  ) {
    throw new Error('NPM returned an invalid PostPlus CLI version payload.');
  }
  return payload;
}

async function readNpmRegistryIdentity(
  runCommand: typeof runDefaultCommand,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const read = async (key: string) =>
      (
        await runCommand('npm', ['config', 'get', key, '--global'], {
          env: environment,
          timeoutMs: 15_000,
        })
      ).stdout.trim();
    const scoped = await read('@postplus:registry');
    const registry =
      !scoped || scoped === 'undefined' || scoped === 'null'
        ? await read('registry')
        : scoped;
    const url = new URL(registry);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      /[\r\n]/u.test(registry)
    ) {
      throw new Error('Invalid registry');
    }
    // Never persist registry credentials or private URLs in the status cache.
    return createHash('sha256').update(registry).digest('hex');
  } catch {
    throw new Error(
      'Failed to determine the npm registry for PostPlus update checks.',
    );
  }
}

async function fetchLatestSkillReleaseId(
  fetchFn: typeof fetch,
): Promise<string> {
  try {
    return (await loadPublicSkillCatalog(fetchFn)).releaseId;
  } catch (error) {
    throw new Error(
      `Failed to check latest ${POSTPLUS_SKILLS_REPO} releaseId: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function readUpdateCheckCache(): Promise<UpdateCheckCache | null> {
  try {
    const raw = await readFile(getUpdateCheckCachePath(), 'utf8');
    const parsed = JSON.parse(raw) as UpdateCheckCache;

    if (
      typeof parsed.checkedAt !== 'string' ||
      typeof parsed.cli?.currentVersion !== 'string' ||
      typeof parsed.cli?.latestVersion !== 'string' ||
      typeof parsed.cli?.registryIdentity !== 'string' ||
      typeof parsed.skills?.latestReleaseId !== 'string'
    ) {
      return null;
    }

    return parsed;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeUpdateCheckCache(cache: UpdateCheckCache): Promise<void> {
  const cachePath = getUpdateCheckCachePath();
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

function getUpdateCheckCachePath(): string {
  return join(getPostPlusConfigDir(), UPDATE_CHECK_CACHE_FILE);
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;

    if (leftPart > rightPart) {
      return 1;
    }

    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

function parseVersion(value: string): number[] {
  return value
    .replace(/^[^\d]*/, '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function shortReleaseId(releaseId: string): string {
  return releaseId.length > 12 ? releaseId.slice(0, 12) : releaseId;
}
