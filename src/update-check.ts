import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  POSTPLUS_CLI_UPDATE_COMMAND,
  POSTPLUS_UPDATE_COMMAND,
  readCurrentCliVersion,
} from './client-compatibility.js';
import {
  runInteractiveCommand as runDefaultInteractiveCommand,
} from './command-runner.js';
import {
  getPostPlusConfigDir,
  readManagedSkillBaseline,
} from './local-state.js';
import {
  POSTPLUS_SKILLS_REPO,
  loadPublicSkillCatalog,
} from './skill-catalog.js';

const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_CACHE_FILE = 'update-check.json';
const NPM_PACKAGE_NAME = '@postplus/cli';
const NPM_LATEST_URL = `https://registry.npmjs.org/${encodeURIComponent(
  NPM_PACKAGE_NAME,
)}/latest`;
const POSTPLUS_CLI_UPDATE_ARGS = ['install', '-g', '@postplus/cli@latest'];
const POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION =
  'POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION';
export const POSTPLUS_CLIENT_RECOVERY_ATTEMPT_ENV =
  'POSTPLUS_CLIENT_RECOVERY_ATTEMPT';

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
  };
  skills: {
    latestReleaseId: string;
  };
};

type UpdateCheckDependencies = {
  fetchFn: typeof fetch;
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
  updateExitCode: number | null;
};

/**
 * Recovers one hosted command rejected by the server-side compatibility gate.
 * That gate runs before billing/provider execution, so one update followed by
 * one retry cannot duplicate a hosted side effect. The child retry carries a
 * process guard: a second compatibility rejection stops instead of looping.
 */
export async function runPostPlusClientUpgradeRecovery(
  input: {
    originalArgs: string[];
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
      updateExitCode: null,
    };
  }

  const recoveryEnvironment = {
    ...environment,
    [POSTPLUS_CLIENT_RECOVERY_ATTEMPT_ENV]: '1',
  };
  writeOutput(
    'PostPlus needs a newer CLI or skill release. Updating before continuing the current task.\n',
  );

  const updateExitCode = await runInteractiveCommand(
    'postplus',
    ['update'],
    { env: recoveryEnvironment },
  );
  if (updateExitCode !== 0) {
    writeError(
      `PostPlus automatic update failed with exit code ${updateExitCode}. The original command was not retried.\n`,
    );
    return {
      attempted: true,
      exitCode: updateExitCode,
      updateExitCode,
    };
  }

  writeOutput('PostPlus update completed. Retrying the original command once.\n');
  const retryExitCode = await runInteractiveCommand(
    'postplus',
    input.originalArgs,
    { env: recoveryEnvironment },
  );

  return {
    attempted: true,
    exitCode: retryExitCode,
    updateExitCode,
  };
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

  if (
    cache &&
    !input.force &&
    cache.cli.currentVersion === currentVersion &&
    Date.now() - Date.parse(cache.checkedAt) < UPDATE_CHECK_TTL_MS
  ) {
    return buildUpdateReport({
      cache,
      currentVersion,
      currentSkillsReleaseId: managedSkillBaseline.releaseId,
      source: 'cache',
    });
  }

  try {
    const [latestCliVersion, latestSkillsReleaseId] = await Promise.all([
      fetchLatestCliVersion(dependencies.fetchFn),
      fetchLatestSkillReleaseId(dependencies.fetchFn),
    ]);
    const nextCache = {
      checkedAt: new Date().toISOString(),
      cli: {
        currentVersion,
        latestVersion: latestCliVersion,
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

    if (cache) {
      return {
        ...buildUpdateReport({
          cache,
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
    fetchFn?: typeof fetch;
    runInteractiveCommand?: typeof runDefaultInteractiveCommand;
    writeOutput?: (message: string) => void;
  } = {},
): Promise<CliSelfUpdateResult> {
  const fetchFn = dependencies.fetchFn ?? fetch;
  const runInteractiveCommand =
    dependencies.runInteractiveCommand ?? runDefaultInteractiveCommand;
  const writeOutput =
    dependencies.writeOutput ?? ((message) => process.stdout.write(message));
  const environment = dependencies.environment ?? process.env;
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

  const latestVersion = await fetchLatestCliVersion(fetchFn);

  if (compareVersions(latestVersion, currentVersion) <= 0) {
    return {
      command: POSTPLUS_CLI_UPDATE_COMMAND,
      currentVersion,
      exitCode: null,
      latestVersion,
      updateAvailable: false,
    };
  }

  writeOutput(
    [
      `PostPlus CLI ${currentVersion} is older than latest ${latestVersion}.`,
      `Updating CLI: ${POSTPLUS_CLI_UPDATE_COMMAND}`,
      '',
    ].join('\n'),
  );

  const exitCode = await runInteractiveCommand('npm', POSTPLUS_CLI_UPDATE_ARGS);

  if (exitCode === 0) {
    const currentCliEntryPath =
      dependencies.currentCliEntryPath ?? process.argv[1];

    if (!currentCliEntryPath) {
      throw new Error(
        'PostPlus CLI updated, but the current CLI entry path is unavailable for continuation.',
      );
    }

    writeOutput(
      [
        `PostPlus CLI updated to ${latestVersion}.`,
        'Continuing with the updated CLI to update skills.',
        '',
      ].join('\n'),
    );

    const continuationExitCode = await runInteractiveCommand(
      process.execPath,
      [currentCliEntryPath, 'update', ...(dependencies.continuationArgs ?? [])],
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
  } else {
    writeOutput(
      [
        `PostPlus CLI update failed with exit code ${exitCode}.`,
        `Fix the npm install error, then rerun: ${POSTPLUS_UPDATE_COMMAND}`,
        '',
      ].join('\n'),
    );
  }

  return {
    command: POSTPLUS_CLI_UPDATE_COMMAND,
    currentVersion,
    exitCode,
    latestVersion,
    updateAvailable: true,
  };
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

async function fetchLatestCliVersion(fetchFn: typeof fetch): Promise<string> {
  const response = await fetchFn(NPM_LATEST_URL, {
    headers: {
      accept: 'application/json',
      'user-agent': `postplus-cli-update-check/${await readCurrentCliVersion()}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to check latest PostPlus CLI version (${response.status}).`,
    );
  }

  const payload = (await response.json()) as { version?: unknown };

  if (typeof payload.version !== 'string' || !payload.version.trim()) {
    throw new Error('NPM returned an invalid PostPlus CLI version payload.');
  }

  return payload.version.trim();
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
