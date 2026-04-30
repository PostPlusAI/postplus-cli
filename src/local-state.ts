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
  accountId?: string;
  refreshToken?: string;
  sessionExpiresAt?: number | null;
  updatedAt?: string;
  userEmail?: string | null;
  userId?: string;
};

export type AuthFieldState = {
  source: 'env' | 'config' | 'missing';
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
  accessToken: AuthFieldState;
  refreshToken: AuthFieldState;
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
    delete next.apiKey;
    delete next.machineId;
    delete next.refreshToken;
    delete next.sessionExpiresAt;
    delete next.userEmail;
    delete next.userId;
    return next;
  });
}

export async function setLocalAccessToken(
  accessToken: string,
): Promise<PostPlusLocalConfig> {
  const normalizedAccessToken = accessToken.trim();
  if (normalizedAccessToken.length === 0) {
    throw new Error('POSTPLUS_ACCESS_TOKEN cannot be empty.');
  }

  return updateLocalConfig((current) => ({
    ...(current ?? {}),
    accessToken: normalizedAccessToken,
  }));
}

export async function setLocalRefreshToken(
  refreshToken: string,
): Promise<PostPlusLocalConfig> {
  const normalizedRefreshToken = refreshToken.trim();
  if (normalizedRefreshToken.length === 0) {
    throw new Error('POSTPLUS_REFRESH_TOKEN cannot be empty.');
  }

  return updateLocalConfig((current) => ({
    ...(current ?? {}),
    refreshToken: normalizedRefreshToken,
  }));
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
  accessToken: string;
  accountId: string;
  apiBaseUrl: string;
  refreshToken: string;
  sessionExpiresAt: number | null;
  userEmail: string | null;
  userId: string;
}): Promise<PostPlusLocalConfig> {
  const accessToken = input.accessToken.trim();
  const refreshToken = input.refreshToken.trim();
  const apiBaseUrl = input.apiBaseUrl.trim().replace(/\/+$/, '');

  if (accessToken.length === 0) {
    throw new Error('POSTPLUS_ACCESS_TOKEN cannot be empty.');
  }

  if (refreshToken.length === 0) {
    throw new Error('POSTPLUS_REFRESH_TOKEN cannot be empty.');
  }

  if (apiBaseUrl.length === 0) {
    throw new Error('POSTPLUS_API_BASE_URL cannot be empty.');
  }

  return updateLocalConfig((current) => ({
    ...omitLegacyAuthFields(current),
    accessToken,
    accountId: input.accountId,
    apiBaseUrl,
    refreshToken,
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

export async function resolveAccessTokenState(): Promise<AuthFieldState> {
  const envValue = process.env.POSTPLUS_ACCESS_TOKEN?.trim();
  if (envValue && envValue.length > 0) {
    return {
      source: 'env',
      present: true,
      value: envValue,
    };
  }

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
  const envValue = process.env.POSTPLUS_REFRESH_TOKEN?.trim();
  if (envValue && envValue.length > 0) {
    return {
      source: 'env',
      present: true,
      value: envValue,
    };
  }

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
  const [accessToken, refreshToken] = await Promise.all([
    resolveAccessTokenState(),
    resolveRefreshTokenState(),
  ]);

  return {
    accessToken,
    refreshToken,
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
    machineId: _machineId,
    ...rest
  } = (current ?? {}) as PostPlusLocalConfig & {
    apiKey?: string;
    machineId?: string;
  };

  return rest;
}
