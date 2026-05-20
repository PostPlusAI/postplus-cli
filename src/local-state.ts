import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
    throw error;
  }
}

const CONFIG_FILE_MODE = 0o600;

export async function writeLocalConfig(
  config: PostPlusLocalConfig,
): Promise<void> {
  const configPath = getPostPlusConfigPath();
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        ...config,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: CONFIG_FILE_MODE },
  );
  // Repair permissions if the file pre-existed with broader access.
  await chmod(configPath, CONFIG_FILE_MODE);
}

export async function assertConfigFilePermissions(): Promise<void> {
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
      throw error;
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
  sessionExpiresAt: number | null;
  userEmail: string | null;
  userId: string;
}): Promise<PostPlusLocalConfig> {
  const cliSessionToken = input.cliSessionToken.trim();
  const apiBaseUrl = input.apiBaseUrl.trim().replace(/\/+$/, '');

  if (cliSessionToken.length === 0) {
    throw new Error('PostPlus CLI session token cannot be empty.');
  }

  if (apiBaseUrl.length === 0) {
    throw new Error('POSTPLUS_API_BASE_URL cannot be empty.');
  }

  return updateLocalConfig((current) => ({
    ...omitLegacyAuthFields(current),
    accountId: input.accountId,
    accountName: input.accountName ?? null,
    accountSlug: input.accountSlug ?? null,
    accountType: input.accountType ?? null,
    apiBaseUrl,
    cliSessionToken,
    sessionExpiresAt: input.sessionExpiresAt,
    userEmail: input.userEmail,
    userId: input.userId,
  }));
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
