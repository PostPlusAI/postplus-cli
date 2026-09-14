import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CommandInterruptedError } from './command-runner.js';

export type PostPlusLocalConfig = {
  accessToken?: string;
  apiBaseUrl?: string;
  cliVersion?: string;
  accountId?: string;
  accountName?: string | null;
  accountSlug?: string | null;
  accountType?: 'personal' | 'team' | null;
  cliSessionToken?: string;
  largeCreditConfirmation?: {
    acknowledgedTierMillicreditsByAccountId?: Record<string, number>;
  };
  managedSkills?: {
    releaseId: string;
    skillNames: string[];
    updatedAt?: string;
  };
  refreshToken?: string;
  sessionExpiresAt?: number | null;
  // Origin against which the current CLI session was minted. Kept separate from
  // apiBaseUrl so an environment override can remain process-local without
  // making a staging token silently usable against production on the next run.
  sessionApiBaseUrl?: string;
  updatedAt?: string;
  userEmail?: string | null;
  userId?: string;
};

export type AuthFieldState = {
  source: 'config' | 'missing';
  present: boolean;
  value: string | null;
};

export const DEFAULT_POSTPLUS_API_BASE_URL = 'https://postplus.io';

export type ApiBaseUrlState = {
  source: 'env' | 'config' | 'default';
  present: boolean;
  value: string | null;
};

export type LocalSessionState = {
  cliSessionToken: AuthFieldState;
};

function resolveConfigProfile(): string | null {
  const value = process.env.POSTPLUS_PROFILE?.trim();

  if (!value || value.toLowerCase() === 'default') {
    return null;
  }

  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function resolveDefaultConfigRoot(): string {
  const profile = resolveConfigProfile();
  const appendProfile = (basePath: string) =>
    profile ? join(basePath, 'profiles', profile) : basePath;

  switch (platform()) {
    case 'darwin':
      return appendProfile(
        join(homedir(), 'Library', 'Application Support', 'postplus'),
      );
    case 'win32': {
      const appData = process.env.APPDATA?.trim();
      return appendProfile(
        appData && appData.length > 0
          ? join(appData, 'postplus')
          : join(homedir(), 'AppData', 'Roaming', 'postplus'),
      );
    }
    default: {
      const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
      return appendProfile(
        xdgConfigHome && xdgConfigHome.length > 0
          ? join(xdgConfigHome, 'postplus')
          : join(homedir(), '.config', 'postplus'),
      );
    }
  }
}

export function getPostPlusConfigDir(): string {
  const override = process.env.POSTPLUS_CONFIG_DIR?.trim();
  return override && override.length > 0
    ? resolve(override)
    : resolveDefaultConfigRoot();
}

export function getPostPlusConfigPath(): string {
  return join(getPostPlusConfigDir(), 'config.json');
}

const UPDATE_LOCK_DIRECTORY = 'update.lock';
const UPDATE_LOCK_POLL_MS = 250;
const UPDATE_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

export async function withPostPlusUpdateLock<T>(
  operation: () => Promise<T>,
  options: {
    installationRoot?: string;
    lockName?: '.postplus-cli-update.lock' | '.postplus-skills-update.lock';
    pollMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const configDir = options.installationRoot ?? getPostPlusConfigDir();
  const lockPath = join(
    configDir,
    options.installationRoot
      ? (options.lockName ?? '.postplus-cli-update.lock')
      : UPDATE_LOCK_DIRECTORY,
  );
  const ownerFile = `owner-${randomUUID()}.json`;
  const candidatePath = join(configDir, `.update-${ownerFile}`);
  const pollMs = options.pollMs ?? UPDATE_LOCK_POLL_MS;
  const timeoutMs = options.timeoutMs ?? UPDATE_LOCK_TIMEOUT_MS;
  const startedAt = Date.now();

  await mkdir(configDir, { recursive: true });
  await mkdir(candidatePath);
  try {
    // Publish a populated directory atomically: a live lock is never empty.
    // The unique filename is also the deletion token. A stale observer can
    // unlink only that generation, never a replacement owner's file.
    await writeFile(
      join(candidatePath, ownerFile),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), operationStarted: false })}\n`,
      { encoding: 'utf8', mode: CONFIG_FILE_MODE },
    );

    while (true) {
      try {
        await rename(candidatePath, lockPath);
        break;
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        const destinationExists =
          nodeError.code === 'EEXIST' ||
          nodeError.code === 'ENOTEMPTY' ||
          (platform() === 'win32' &&
            (nodeError.code === 'EACCES' || nodeError.code === 'EPERM') &&
            (await stat(lockPath).then(
              (value) => value.isDirectory(),
              () => false,
            )));
        if (!destinationExists) {
          throw error;
        }

        const owner = await readPostPlusUpdateLockOwner(lockPath);
        if (owner && !owner.alive) {
          if (
            options.installationRoot &&
            owner.file &&
            owner.operationStarted !== false
          ) {
            throw new Error(
              `PostPlus cannot confirm whether an interrupted installer is still running (code=postplus_update_installation_uncertain). No update was started and the lock was retained at ${lockPath}. Confirm the installer has stopped before removing this lock.`,
            );
          }
          await removePostPlusUpdateLockOwner(lockPath, owner.file);
        }

        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(
            'Another PostPlus update is still running. Wait for it to finish, then retry.',
          );
        }

        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }

    let releaseLock = true;
    try {
      if (options.installationRoot) {
        // Persist before spawning an installer. A dead parent is not proof that
        // npm (or a Windows shim's descendant) stopped; do not auto-reclaim it.
        await writeFile(
          join(lockPath, ownerFile),
          `${JSON.stringify({ pid: process.pid, operationStarted: true })}\n`,
          { encoding: 'utf8', mode: CONFIG_FILE_MODE },
        );
      }
      return await operation();
    } catch (error) {
      if (
        options.installationRoot &&
        error instanceof CommandInterruptedError
      ) {
        releaseLock = false;
        throw new Error(
          `PostPlus installer or continuation was interrupted (code=postplus_update_installation_uncertain). The lock was retained at ${lockPath}; confirm its child processes have stopped before removing it.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (releaseLock) await removePostPlusUpdateLockOwner(lockPath, ownerFile);
    }
  } finally {
    // Only our unpublished, uniquely named staging directory may be removed
    // recursively. Never recursively delete the shared update.lock path.
    await rm(candidatePath, { force: true, recursive: true });
  }
}

async function removePostPlusUpdateLockOwner(
  lockPath: string,
  ownerFile: string | null,
): Promise<void> {
  if (ownerFile) {
    try {
      await unlink(join(lockPath, ownerFile));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  try {
    await rmdir(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
      throw error;
    }
  }
}

async function readPostPlusUpdateLockOwner(lockPath: string): Promise<{
  alive: boolean;
  file: string | null;
  operationStarted?: boolean;
} | null> {
  let file: string | null = null;
  try {
    const files = await readdir(lockPath);
    if (
      files.length > 1 ||
      (files[0] && !/^owner(?:-[a-f0-9-]+)?\.json$/u.test(files[0]))
    ) {
      throw new Error(
        'PostPlus update lock has unexpected contents; no files were removed.',
      );
    }
    file = files[0] ?? null;
    if (!file) {
      return { alive: false, file: null };
    }
    const owner = JSON.parse(await readFile(join(lockPath, file), 'utf8')) as {
      pid?: unknown;
      operationStarted?: unknown;
    };
    const operationStarted =
      typeof owner.operationStarted === 'boolean'
        ? owner.operationStarted
        : undefined;
    if (!Number.isInteger(owner.pid) || (owner.pid as number) <= 0) {
      return { alive: false, file, operationStarted };
    }

    try {
      process.kill(owner.pid as number, 0);
      return { alive: true, file, operationStarted };
    } catch (error) {
      return {
        alive: (error as NodeJS.ErrnoException).code !== 'ESRCH',
        file,
        operationStarted,
      };
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT' && nodeError.name !== 'SyntaxError') {
      throw error;
    }

    try {
      const lock = await stat(lockPath);
      return { alive: Date.now() - lock.mtimeMs < 5_000, file };
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw statError;
    }
  }
}

export async function readLocalConfig(): Promise<PostPlusLocalConfig | null> {
  const configPath = getPostPlusConfigPath();

  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as PostPlusLocalConfig;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw new PostPlusLocalConfigError('read', error);
  }
}

const CONFIG_FILE_MODE = 0o600;

type ConfigFailureStage =
  | 'read'
  | 'write'
  | 'permissions'
  | 'commit'
  | 'cleanup';

export class PostPlusLocalConfigError extends Error {
  readonly code: string;
  readonly systemCode: string;
  constructor(
    readonly stage: ConfigFailureStage,
    error: unknown,
  ) {
    const systemCode =
      error instanceof SyntaxError
        ? 'INVALID_JSON'
        : ((error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN');
    const code = `postplus_cli_config_${stage}_failed`;
    // JSON parser excerpts and arbitrary filesystem messages may contain secrets.
    super(
      `PostPlus local configuration ${stage} failed (${systemCode}; code=${code}). Check access to ${getPostPlusConfigPath()}. Do not repeat login until local storage is ready.`,
    );
    this.name = 'PostPlusLocalConfigError';
    this.code = code;
    this.systemCode = systemCode;
  }
}

// Windows access is governed by ACLs; POSIX mode bits are not an ACL check.
export function usesPosixConfigPermissions(osPlatform = platform()): boolean {
  return osPlatform !== 'win32';
}

async function stageLocalConfig(
  contents: string,
  commit: boolean,
): Promise<void> {
  const configPath = getPostPlusConfigPath();
  const temporaryPath = join(
    dirname(configPath),
    `.config-${randomUUID()}.tmp`,
  );
  let stage: ConfigFailureStage = 'write';
  let created = false;
  try {
    await mkdir(dirname(configPath), { recursive: true });
    // Atomic replacement must not silently override a read-only target.
    try {
      await access(configPath, fsConstants.W_OK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const file = await open(temporaryPath, 'wx', CONFIG_FILE_MODE);
    created = true;
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
      if (usesPosixConfigPermissions()) {
        stage = 'permissions';
        await file.chmod(CONFIG_FILE_MODE);
      }
    } finally {
      await file.close();
    }
    if (commit) {
      stage = 'commit';
      await rename(temporaryPath, configPath);
      created = false;
    }
  } catch (error) {
    throw new PostPlusLocalConfigError(stage, error);
  } finally {
    if (created) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        throw new PostPlusLocalConfigError('cleanup', error);
      }
    }
  }
}

export async function assertLocalConfigWritable(): Promise<void> {
  // A probe proves prerequisites, not that a later save cannot fail.
  await readLocalConfig();
  await assertConfigFilePermissions();
  await stageLocalConfig('{}\n', false);
}

export async function writeLocalConfig(
  config: PostPlusLocalConfig,
): Promise<void> {
  await stageLocalConfig(
    `${JSON.stringify(
      {
        ...config,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    true,
  );
}

export async function assertConfigFilePermissions(): Promise<void> {
  if (!usesPosixConfigPermissions()) return;
  const configPath = getPostPlusConfigPath();

  try {
    const info = await stat(configPath);
    const mode = info.mode & 0o777;

    if (mode !== CONFIG_FILE_MODE) {
      process.stderr.write(
        `PostPlus CLI: repairing config file permissions at ${configPath} (was ${mode.toString(8)}, setting to ${CONFIG_FILE_MODE.toString(8)}).\n`,
      );
      await chmod(configPath, CONFIG_FILE_MODE);
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw new PostPlusLocalConfigError('permissions', error);
    }
  }
}

export async function updateLocalConfig(
  updater: (current: PostPlusLocalConfig | null) => PostPlusLocalConfig,
): Promise<PostPlusLocalConfig> {
  const next = updater(await readLocalConfig());
  await writeLocalConfig(next);
  return next;
}

export async function clearLocalAuthState(): Promise<PostPlusLocalConfig> {
  return updateLocalConfig((current) => {
    const next = {
      ...((current ?? {}) as PostPlusLocalConfig & {
        apiKey?: string;
        machineId?: string;
      }),
    };
    delete next.accessToken;
    delete next.accountId;
    delete next.accountName;
    delete next.accountSlug;
    delete next.accountType;
    delete next.apiKey;
    delete next.cliSessionToken;
    delete next.machineId;
    delete next.refreshToken;
    delete next.sessionApiBaseUrl;
    delete next.sessionExpiresAt;
    delete next.userEmail;
    delete next.userId;
    return next;
  });
}

export async function readManagedSkillBaseline(): Promise<{
  releaseId: string | null;
  skillNames: string[];
}> {
  const config = await readLocalConfig();
  const managedSkills = config?.managedSkills;

  if (
    !managedSkills ||
    typeof managedSkills.releaseId !== 'string' ||
    !Array.isArray(managedSkills.skillNames)
  ) {
    return {
      releaseId: null,
      skillNames: [],
    };
  }

  return {
    releaseId: managedSkills.releaseId,
    skillNames: normalizeSkillNames(managedSkills.skillNames),
  };
}

export async function writeManagedSkillBaseline(input: {
  releaseId: string;
  skillNames: string[];
}): Promise<PostPlusLocalConfig> {
  return updateLocalConfig((current) => ({
    ...(current ?? {}),
    managedSkills: {
      releaseId: input.releaseId,
      skillNames: normalizeSkillNames(input.skillNames),
      updatedAt: new Date().toISOString(),
    },
  }));
}

export async function clearManagedSkillBaseline(): Promise<PostPlusLocalConfig> {
  return updateLocalConfig((current) => {
    const next = {
      ...(current ?? {}),
    };
    delete next.managedSkills;
    return next;
  });
}

export async function setLocalApiBaseUrl(
  apiBaseUrl: string,
): Promise<PostPlusLocalConfig> {
  const normalizedApiBaseUrl = apiBaseUrl.trim();

  if (normalizedApiBaseUrl.length === 0) {
    throw new Error('POSTPLUS_API_BASE_URL cannot be empty.');
  }

  const normalizedUrl = new URL(normalizedApiBaseUrl).toString();

  return updateLocalConfig((current) => ({
    ...(current ?? {}),
    apiBaseUrl: normalizedUrl.replace(/\/+$/, ''),
  }));
}

export async function setLocalSession(input: {
  accountId: string;
  accountName?: string | null;
  accountSlug?: string | null;
  accountType?: 'personal' | 'team' | null;
  apiBaseUrl: string;
  cliSessionToken: string;
  cliVersion?: string;
  sessionExpiresAt: number | null;
  userEmail: string | null;
  userId: string;
  persistApiBaseUrl?: boolean;
}): Promise<PostPlusLocalConfig> {
  const cliSessionToken = input.cliSessionToken.trim();
  const apiBaseUrl = input.apiBaseUrl.trim().replace(/\/+$/, '');

  if (cliSessionToken.length === 0) {
    throw new Error('PostPlus CLI session token cannot be empty.');
  }

  if (apiBaseUrl.length === 0) {
    throw new Error('POSTPLUS_API_BASE_URL cannot be empty.');
  }

  return updateLocalConfig((current) => {
    const next: PostPlusLocalConfig = {
      ...omitLegacyAuthFields(current),
      ...(input.cliVersion ? { cliVersion: input.cliVersion } : {}),
      accountId: input.accountId,
      accountName: input.accountName ?? null,
      accountSlug: input.accountSlug ?? null,
      accountType: input.accountType ?? null,
      cliSessionToken,
      sessionApiBaseUrl: apiBaseUrl,
      sessionExpiresAt: input.sessionExpiresAt,
      userEmail: input.userEmail,
      userId: input.userId,
    };
    if (input.persistApiBaseUrl !== false) {
      next.apiBaseUrl = apiBaseUrl;
    }
    return next;
  });
}

export async function hasLocalConfigFile(): Promise<boolean> {
  try {
    await access(getPostPlusConfigPath(), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCliSessionTokenState(): Promise<AuthFieldState> {
  const config = await readLocalConfig();
  const configValue = config?.cliSessionToken?.trim();
  if (configValue && configValue.length > 0) {
    return {
      source: 'config',
      present: true,
      value: configValue,
    };
  }

  return {
    source: 'missing',
    present: false,
    value: null,
  };
}

export async function resolveAccessTokenState(): Promise<AuthFieldState> {
  const config = await readLocalConfig();
  const configValue = config?.accessToken?.trim();
  if (configValue && configValue.length > 0) {
    return {
      source: 'config',
      present: true,
      value: configValue,
    };
  }

  return {
    source: 'missing',
    present: false,
    value: null,
  };
}

export async function resolveRefreshTokenState(): Promise<AuthFieldState> {
  const config = await readLocalConfig();
  const configValue = config?.refreshToken?.trim();
  if (configValue && configValue.length > 0) {
    return {
      source: 'config',
      present: true,
      value: configValue,
    };
  }

  return {
    source: 'missing',
    present: false,
    value: null,
  };
}

export async function resolveLocalSessionState(): Promise<LocalSessionState> {
  const cliSessionToken = await resolveCliSessionTokenState();

  return {
    cliSessionToken,
  };
}

export async function resolveApiBaseUrlState(): Promise<ApiBaseUrlState> {
  const envApiBaseUrl = process.env.POSTPLUS_API_BASE_URL?.trim();
  if (envApiBaseUrl && envApiBaseUrl.length > 0) {
    return {
      source: 'env',
      present: true,
      value: envApiBaseUrl.replace(/\/+$/, ''),
    };
  }

  const config = await readLocalConfig();
  const configApiBaseUrl = config?.apiBaseUrl?.trim();
  if (configApiBaseUrl && configApiBaseUrl.length > 0) {
    return {
      source: 'config',
      present: true,
      value: configApiBaseUrl.replace(/\/+$/, ''),
    };
  }

  return {
    source: 'default',
    present: true,
    value: DEFAULT_POSTPLUS_API_BASE_URL,
  };
}

export function maskSecret(value: string | null): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }

  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function omitLegacyAuthFields(
  current: PostPlusLocalConfig | null,
): PostPlusLocalConfig {
  const {
    apiKey: _apiKey,
    accessToken: _accessToken,
    machineId: _machineId,
    refreshToken: _refreshToken,
    ...rest
  } = (current ?? {}) as PostPlusLocalConfig & {
    apiKey?: string;
    machineId?: string;
  };

  return rest;
}

function normalizeSkillNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}
