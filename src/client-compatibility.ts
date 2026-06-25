import { readFile } from 'node:fs/promises';

import { readLocalConfig, updateLocalConfig } from './local-state.js';

export const POSTPLUS_CLIENT_CONTRACT_VERSION = 2;
export const POSTPLUS_CLIENT_RUNTIME = 'postplus-cli';
// Single source for the CLI self-update command. Lives here (the upgrade-error
// formatter's home) so update-check.ts can import it without a cycle —
// update-check already depends on this module for readCurrentCliVersion.
export const POSTPLUS_CLI_UPDATE_COMMAND =
  'npm install -g @postplus/cli@latest';

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
    /**
     * In-process override for the skills release id stamped into
     * `x-postplus-skills-release-id`. When provided (the hosted-lib path), it is
     * used verbatim and the disk config is NOT read for the release id. When
     * omitted (the bin path), the release id comes from `readLocalConfig()` as
     * before. Either way the cliVersion is read from the package version.
     */
    skillsReleaseId?: string | null;
  } = {},
): Promise<Record<string, string>> {
  const hasReleaseIdOverride = input.skillsReleaseId !== undefined;
  const [cliVersion, config] = await Promise.all([
    readCurrentCliVersion(),
    hasReleaseIdOverride ? Promise.resolve(null) : readLocalConfig(),
  ]);
  const headers: Record<string, string> = {
    [POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.cliVersion]: cliVersion,
    [POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.contractVersion]: String(
      POSTPLUS_CLIENT_CONTRACT_VERSION,
    ),
    [POSTPLUS_CLIENT_COMPATIBILITY_HEADERS.runtime]: POSTPLUS_CLIENT_RUNTIME,
  };
  const skillsReleaseId = hasReleaseIdOverride
    ? input.skillsReleaseId?.trim()
    : config?.managedSkills?.releaseId?.trim();
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
    record.compatibility?.upgrade?.cli?.command ?? POSTPLUS_CLI_UPDATE_COMMAND;
  const skillsCommand =
    record.compatibility?.upgrade?.skills?.command ?? 'postplus update';
  const restart = record.compatibility?.upgrade?.restartAgentSession
    ? ' Then restart your agent session.'
    : '';

  return [
    typeof record.error === 'string' && record.error.trim().length > 0
      ? record.error.trim()
      : 'Your PostPlus CLI or PostPlus skills are out of date.',
    'If you are an agent, run both update commands now before retrying.',
    `Update CLI: ${cliCommand}.`,
    `Update skills: ${skillsCommand}.`,
    restart.trim(),
  ]
    .filter(Boolean)
    .join(' ');
}

export function formatPostPlusCloudReleaseInProgressError(payload: unknown) {
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { error?: unknown })
      : {};

  return typeof record.error === 'string' && record.error.trim().length > 0
    ? record.error.trim()
    : 'PostPlus Cloud is updating. Please retry in about one minute.';
}

export function formatPostPlusCompatibilityError(payload: unknown) {
  if (isPostPlusClientUpgradePayload(payload)) {
    return formatPostPlusClientUpgradeError(payload);
  }

  if (isPostPlusCloudReleaseInProgressPayload(payload)) {
    return formatPostPlusCloudReleaseInProgressError(payload);
  }

  return null;
}

export function isPostPlusClientUpgradePayload(payload: unknown) {
  return (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    'code' in payload &&
    payload.code === 'postplus_client_upgrade_required'
  );
}

export function isPostPlusCloudReleaseInProgressPayload(payload: unknown) {
  return (
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    'code' in payload &&
    payload.code === 'postplus_cli_cloud_release_in_progress'
  );
}
