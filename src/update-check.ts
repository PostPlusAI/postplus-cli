import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getPostPlusConfigDir } from './local-state.js';
import { POSTPLUS_SKILLS_REPO } from './skill-catalog.js';

const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_CACHE_FILE = 'update-check.json';
const NPM_PACKAGE_NAME = '@postplus/cli';
const NPM_LATEST_URL = `https://registry.npmjs.org/${encodeURIComponent(
  NPM_PACKAGE_NAME,
)}/latest`;
const POSTPLUS_SKILLS_MAIN_URL =
  'https://api.github.com/repos/PostPlusAI/postplus-skills/commits/main';

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
    currentRevision: string | null;
    latestRevision: string | null;
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
    latestRevision: string;
  };
};

type UpdateCheckDependencies = {
  fetchFn: typeof fetch;
};

export async function generateUpdateStatusReport(
  input: {
    force?: boolean;
    resetSkillBaseline?: boolean;
  } = {},
  dependencies: UpdateCheckDependencies = {
    fetchFn: fetch,
  },
): Promise<UpdateStatusReport> {
  const currentVersion = await readCurrentCliVersion();
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
      previousSkillRevision: cache.skills.latestRevision,
      source: 'cache',
    });
  }

  try {
    const [latestCliVersion, latestSkillRevision] = await Promise.all([
      fetchLatestCliVersion(dependencies.fetchFn),
      fetchLatestSkillRevision(dependencies.fetchFn),
    ]);
    const nextCache = {
      checkedAt: new Date().toISOString(),
      cli: {
        currentVersion,
        latestVersion: latestCliVersion,
      },
      skills: {
        latestRevision: latestSkillRevision,
      },
    };
    await writeUpdateCheckCache(nextCache);

    return buildUpdateReport({
      cache: nextCache,
      currentVersion,
      previousSkillRevision: input.resetSkillBaseline
        ? latestSkillRevision
        : cache?.skills.latestRevision ?? latestSkillRevision,
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
          previousSkillRevision: cache.skills.latestRevision,
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
        updateCommand: 'npm install -g @postplus/cli',
      },
      skills: {
        currentRevision: null,
        latestRevision: null,
        updateAvailable: false,
        updateCommand: 'postplus update',
      },
      warning,
    };
  }
}

export async function refreshUpdateCheckBaseline(): Promise<void> {
  await generateUpdateStatusReport({
    force: true,
    resetSkillBaseline: true,
  });
}

export function formatUpdateStatusReport(report: UpdateStatusReport): string {
  const lines = ['PostPlus update status', ''];

  const cliMarker = report.cli.updateAvailable ? '[WARN]' : '[PASS]';
  lines.push(
    `${cliMarker} CLI: ${report.cli.currentVersion}${
      report.cli.latestVersion ? ` (latest ${report.cli.latestVersion})` : ''
    }`,
  );
  if (report.cli.updateAvailable) {
    lines.push(`  Update: ${report.cli.updateCommand}`);
  }

  const skillMarker = report.skills.updateAvailable ? '[WARN]' : '[PASS]';
  lines.push(
    `${skillMarker} Skills: ${
      report.skills.latestRevision
        ? `release ${shortRevision(report.skills.latestRevision)}`
        : 'release unknown'
    }`,
  );
  if (report.skills.updateAvailable) {
    lines.push(`  Update: ${report.skills.updateCommand}`);
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
  previousSkillRevision: string;
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
        compareVersions(input.cache.cli.latestVersion, input.currentVersion) > 0,
      updateCommand: 'npm install -g @postplus/cli',
    },
    skills: {
      currentRevision: input.previousSkillRevision,
      latestRevision: input.cache.skills.latestRevision,
      updateAvailable:
        input.cache.skills.latestRevision !== input.previousSkillRevision,
      updateCommand: 'postplus update',
    },
    warning: null,
  };
}

async function readCurrentCliVersion(): Promise<string> {
  const packageJsonPath = new URL('../package.json', import.meta.url);
  const raw = await readFile(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };

  if (typeof parsed.version !== 'string' || !parsed.version.trim()) {
    throw new Error('Could not read the current PostPlus CLI version.');
  }

  return parsed.version.trim();
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

async function fetchLatestSkillRevision(fetchFn: typeof fetch): Promise<string> {
  const response = await fetchFn(POSTPLUS_SKILLS_MAIN_URL, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `postplus-cli-update-check/${await readCurrentCliVersion()}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to check latest ${POSTPLUS_SKILLS_REPO} revision (${response.status}).`,
    );
  }

  const payload = (await response.json()) as { sha?: unknown };

  if (typeof payload.sha === 'string' && payload.sha.trim()) {
    return payload.sha.trim();
  }

  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

async function readUpdateCheckCache(): Promise<UpdateCheckCache | null> {
  try {
    const raw = await readFile(getUpdateCheckCachePath(), 'utf8');
    const parsed = JSON.parse(raw) as UpdateCheckCache;

    if (
      typeof parsed.checkedAt !== 'string' ||
      typeof parsed.cli?.currentVersion !== 'string' ||
      typeof parsed.cli?.latestVersion !== 'string' ||
      typeof parsed.skills?.latestRevision !== 'string'
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

function shortRevision(revision: string): string {
  return revision.length > 12 ? revision.slice(0, 12) : revision;
}
