import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PostPlusSkillsInstallScope } from './skill-catalog.js';

const SKILLS_INSTALLER_GLOBAL_LOCK_PATH = ['.agents', '.skill-lock.json'];
const SKILLS_INSTALLER_PROJECT_LOCK_PATH = 'skills-lock.json';
const SKILLS_INSTALLER_POSTPLUS_SOURCE = 'postplusai/postplus-skills';

export type PostPlusInstallerLockedSkillEntry = {
  expectedContentHash: string | null;
  hashKind: 'folder-sha256' | 'git-tree-sha1' | null;
  name: string;
  scope: 'global' | 'project';
};

export async function readPostPlusInstallerLockedSkillEntries(
  scope: PostPlusSkillsInstallScope,
): Promise<PostPlusInstallerLockedSkillEntry[]> {
  const lockPaths =
    scope === 'global'
      ? [
          {
            path: getSkillsInstallerGlobalLockPath(),
            scope: 'global' as const,
          },
        ]
      : [
          {
            path: getSkillsInstallerProjectLockPath(),
            scope: 'project' as const,
          },
        ];
  const entries = await Promise.all(
    lockPaths.map((lock) =>
      readPostPlusInstallerLockedSkillNamesFromPath(lock.path).then(
        (lockedEntries) =>
          lockedEntries.map((entry) => ({
            ...entry,
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
): Promise<
  Array<{
    expectedContentHash: string | null;
    hashKind: 'folder-sha256' | 'git-tree-sha1' | null;
    name: string;
  }>
> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const payload = JSON.parse(raw) as unknown;

    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      throw new Error('Invalid skills installer lock.');
    }

    const record = payload as Record<string, unknown>;
    if (typeof record.version !== 'number') {
      throw new Error('Invalid skills installer lock version.');
    }

    if (
      !record.skills ||
      typeof record.skills !== 'object' ||
      Array.isArray(record.skills)
    ) {
      throw new Error('Invalid skills installer lock entries.');
    }

    return Object.entries(record.skills as Record<string, unknown>)
      .filter(([, entry]) => isPostPlusSkillsInstallerLockEntry(entry))
      .map(([skillName, entry]) => ({
        ...readInstallerLockContentHash(entry),
        name: skillName.trim(),
      }))
      .filter((entry) => Boolean(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function readInstallerLockContentHash(
  entry: unknown,
): Pick<
  PostPlusInstallerLockedSkillEntry,
  'expectedContentHash' | 'hashKind'
> {
  const record = entry as Record<string, unknown>;
  const skillFolderHash =
    typeof record.skillFolderHash === 'string'
      ? record.skillFolderHash.trim().toLowerCase()
      : '';
  if (/^[0-9a-f]{40}$/.test(skillFolderHash)) {
    return {
      expectedContentHash: skillFolderHash,
      hashKind: 'git-tree-sha1',
    };
  }

  const computedHash =
    typeof record.computedHash === 'string'
      ? record.computedHash.trim().toLowerCase()
      : '';
  if (/^[0-9a-f]{64}$/.test(computedHash)) {
    return {
      expectedContentHash: computedHash,
      hashKind: 'folder-sha256',
    };
  }

  return {
    expectedContentHash: null,
    hashKind: null,
  };
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
  } else if (
    /^https?:\/\//i.test(normalized) ||
    /^ssh:\/\//i.test(normalized)
  ) {
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

export async function resolvePostPlusSkillsScope(): Promise<PostPlusSkillsInstallScope> {
  try {
    // An unreadable/deleted cwd or invalid lock must not redirect a project
    // update into the user's global installation.
    await realpath(process.cwd());
    const project = await readPostPlusInstallerLockedSkillEntries(
      'current-directory',
    );
    return project.length > 0 ? 'current-directory' : 'global';
  } catch (cause) {
    throw new PostPlusSkillsStateError('scope', cause);
  }
}

export async function resolvePostPlusSkillsRoot(
  scope?: PostPlusSkillsInstallScope,
): Promise<string> {
  const targetScope = scope ?? (await resolvePostPlusSkillsScope());
  return realpath(targetScope === 'global' ? homedir() : process.cwd());
}

export class PostPlusSkillsStateError extends Error {
  readonly code: string;
  constructor(stage: string, cause: unknown) {
    const code = `postplus_skills_${stage}_failed`;
    super(
      `PostPlus Skills ${stage} failed (code=${code}). No installation was claimed current.`,
      { cause },
    );
    this.code = code;
    this.name = 'PostPlusSkillsStateError';
  }
}

type ManagedSkillBaseline = {
  releaseId: string | null;
  skillNames: string[];
};

export async function readManagedSkillBaseline(
  scope?: PostPlusSkillsInstallScope,
): Promise<ManagedSkillBaseline> {
  const installationRoot = await resolvePostPlusSkillsRoot(scope);
  try {
    const record = JSON.parse(
      await readFile(
        join(installationRoot, '.postplus-skills.json'),
        'utf8',
      ),
    );
    if (
      typeof record?.releaseId !== 'string' ||
      !record.releaseId.trim() ||
      !Array.isArray(record.skillNames) ||
      !record.skillNames.every((name: unknown) => typeof name === 'string')
    ) {
      throw new Error('Invalid installation baseline.');
    }
    return { releaseId: record.releaseId, skillNames: record.skillNames };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
      return { releaseId: null, skillNames: [] };
    throw new PostPlusSkillsStateError('baseline_read', cause);
  }
}

export async function writeManagedSkillBaseline(
  input: { releaseId: string; skillNames: string[] },
  scope?: PostPlusSkillsInstallScope,
): Promise<void> {
  await stageManagedSkillBaseline(input, scope, true);
}

export async function assertPostPlusSkillsBaselineWritable(
  scope: PostPlusSkillsInstallScope,
): Promise<void> {
  await stageManagedSkillBaseline(
    { releaseId: '', skillNames: [] },
    scope,
    false,
  );
}

async function stageManagedSkillBaseline(
  input: { releaseId: string; skillNames: string[] },
  scope: PostPlusSkillsInstallScope | undefined,
  commit: boolean,
): Promise<void> {
  const installationRoot = await resolvePostPlusSkillsRoot(scope);
  const target = join(installationRoot, '.postplus-skills.json');
  const temporary = join(
    installationRoot,
    `.postplus-skills-${randomUUID()}.tmp`,
  );
  let created = false;
  try {
    try {
      await access(target, constants.W_OK);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(
        `${JSON.stringify(
          {
            releaseId: input.releaseId,
            skillNames: [
              ...new Set(
                input.skillNames
                  .map((name) => name.trim())
                  .filter(Boolean),
              ),
            ].sort(),
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      await file.sync();
      if (process.platform !== 'win32') await file.chmod(0o600);
    } finally {
      await file.close();
    }
    if (commit) {
      await rename(temporary, target);
      created = false;
    }
  } catch (cause) {
    throw new PostPlusSkillsStateError('baseline_write', cause);
  } finally {
    if (created) {
      try {
        await unlink(temporary);
      } catch (cause) {
        throw new PostPlusSkillsStateError('baseline_cleanup', cause);
      }
    }
  }
}

export async function clearManagedSkillBaseline(
  scope?: PostPlusSkillsInstallScope,
): Promise<void> {
  const installationRoot = await resolvePostPlusSkillsRoot(scope);
  try {
    await unlink(join(installationRoot, '.postplus-skills.json'));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new PostPlusSkillsStateError('baseline_clear', cause);
  }
}
