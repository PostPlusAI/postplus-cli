import { readFile } from 'node:fs/promises';

import { readLocalConfig, updateLocalConfig } from './local-state.js';

export const POSTPLUS_CLIENT_CONTRACT_VERSION = 1;
export const POSTPLUS_CLIENT_RUNTIME = 'postplus-cli';

export const POSTPLUS_CLIENT_COMPATIBILITY_HEADERS = {
  cliVersion: 'x-postplus-cli-version',
  contractVersion: 'x-postplus-client-contract-version',
  runtime: 'x-postplus-client-runtime',
  skillsReleaseId: 'x-postplus-skills-release-id',
  skillName: 'x-postplus-skill-name',
} as const;

export type PostPlusClientUpgradePayload = {
  code?: string;
  compatibility?: {
    upgrade?: {
      cli?: {
        command?: string;
      };
      restartAgentSession?: boolean;
      skills?: {
        command?: string;
      };
    };
  };
  error?: string;
};

export async function buildPostPlusClientCompatibilityHeaders(
  input: {
    skillName?: string | null;
  } = {},
): Promise<Record<string, string>> {
  const [cliVersion, config] = await Promise.all([
    readCurrentCliVersion(),
    readLocalConfig(),
  ]);
  const headers: Record<string, string> = {
    [POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.cliVersion]: cliVersion,
    [POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.contractVersion]: String(
      POSTPLUS_CLIENT_CONTRACT_VERSION,
    ),
    [POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.runtime]: POSTPLUS_CLIENT_RUNTIME,
  };
  const skillsReleaseId = config?.managedSkills?.releaseId?.trim();
  const skillName = input.skillName?.trim();

  if (skillsReleaseId) {
    headers[POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.skillsReleaseId] =
      skillsReleaseId;
  }

  if (skillName) {
    headers[POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.skillName] = skillName;
  }

  return headers;
}

export async function writeCurrentCliVersionToLocalConfig(): Promise<void> {
  const cliVersion = await readCurrentCliVersion();

  await updateLocalConfig((current) => ({
    ...(current ?? {}),
    cliVersion,
  }));
}

export async function readCurrentCliVersion(): Promise<string> {
  const packageJsonPath = new URL('../package.json', import.meta.url);
  const raw = await readFile(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };

  if (typeof parsed.version !== 'string' || !parsed.version.trim()) {
    throw new Error('Could not read the current PostPlus CLI version.');
  }

  return parsed.version.trim();
}

export function formatPostPlusClientUpgradeError(payload: unknown) {
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as PostPlusClientUpgradePayload)
      : {};
  const cliCommand =
    record.compatibility?.upgrade?.cli?.command ??
    'npm install -g @postplus/cli';
  const skillsCommand =
    record.compatibility?.upgrade?.skills?.command ?? 'postplus update';
  const restart = record.compatibility?.upgrade?.restartAgentSession
    ? ' Then restart your agent session.'
    : '';

  return [
    typeof record.error === 'string' && record.error.trim().length > 0
      ? record.error.trim()
      : 'Your PostPlus CLI or PostPlus skills are out of date.',
    `Update CLI: ${cliCommand}.`,
    `Update skills: ${skillsCommand}.`,
    restart.trim(),
  ]
    .filter(Boolean)
    .join(' ');
}
