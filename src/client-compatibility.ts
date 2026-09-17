import { readFile } from 'node:fs/promises';

import {
  readManagedSkillBaseline,
  updateLocalConfig,
} from './local-state.js';

export const POSTPLUS_CLIENT_CONTRACT_VERSION = 4;
export const POSTPLUS_CLIENT_RUNTIME = 'postplus-cli';
export const POSTPLUS_UPDATE_COMMAND = 'postplus update';
// Single source for the low-level npm self-update command. It lives beside the
// compatibility commands so update-check.ts can import both without a cycle.
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
    reason?: string;
    received?: { cliVersion?: string | null; skillsReleaseId?: string | null };
    required?: { cliVersion?: string; skillsReleaseId?: string; releaseId?: string };
    upgrade?: {
      command?: string;
      cli?: {
        command?: string;
        required?: boolean;
      };
      restartAgentSession?: boolean;
      skills?: {
        command?: string;
        required?: boolean;
      };
    };
  };
  error?: string;
};

export class PostPlusClientUpgradeRequiredError extends Error {
  readonly code = 'postplus_client_upgrade_required';
  readonly stage = 'compatibility';
  readonly service = 'postplus-cloud';
  readonly retryable = false;
  readonly compatibilityReason: string;
  readonly summary: string;
  readonly action = 'Run postplus update.';
  readonly versions: { cliVersion: string | null; skillsReleaseId: string | null; requiredCliVersion: string | null; requiredSkillsReleaseId: string | null };
  // Commands that already own durable work resume that identity after updating.
  // Absent for requests rejected before work began: their original argv is safe.
  recoveryArgs?: string[];

  constructor(readonly payload: PostPlusClientUpgradePayload) {
    super(formatPostPlusClientUpgradeError(payload));
    this.name = 'PostPlusClientUpgradeRequiredError';
    const compatibility = payload.compatibility;
    const missingSkills = compatibility?.upgrade?.skills?.required && compatibility.received?.skillsReleaseId === null;
    this.compatibilityReason = missingSkills ? 'skills_baseline_missing'
      : compatibility?.reason ?? (compatibility?.upgrade?.cli?.required ? 'cli_release_too_old'
        : compatibility?.upgrade?.skills?.required ? 'skills_release_mismatch' : 'client_compatibility');
    this.summary = missingSkills ? 'PostPlus has no verified skill installation record.'
      : this.compatibilityReason === 'cli_release_too_old' ? 'Your PostPlus CLI is out of date.'
      : this.compatibilityReason === 'skills_release_mismatch' ? 'Your installed PostPlus skills are out of date.'
      : 'Your PostPlus installation needs an update.';
    this.versions = {
      cliVersion: compatibility?.received?.cliVersion ?? null,
      skillsReleaseId: compatibility?.received?.skillsReleaseId ?? null,
      requiredCliVersion: compatibility?.required?.cliVersion ?? null,
      requiredSkillsReleaseId: compatibility?.required?.skillsReleaseId ?? null,
    };
  }
}

export async function buildPostPlusClientCompatibilityHeaders(
  input: {
    skillName?: string | null;
    /**
     * In-process override for the skills release id stamped into
     * `x-postplus-skills-release-id`. When provided (the hosted-lib path), it is
     * used verbatim and the disk config is NOT read for the release id. When
     * omitted (the bin path), the release id comes from the selected installation's
     * verified baseline. Either way cliVersion is read from the package version.
     */
    skillsReleaseId?: string | null;
  } = {},
): Promise<Record<string, string>> {
  const hasReleaseIdOverride = input.skillsReleaseId !== undefined;
  const [cliVersion, baseline] = await Promise.all([
    readCurrentCliVersion(),
    hasReleaseIdOverride
      ? Promise.resolve(null)
      : readManagedSkillBaseline(),
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
    : baseline?.releaseId?.trim();
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
  const updateCommand =
    record.compatibility?.upgrade?.command?.trim() || POSTPLUS_UPDATE_COMMAND;
  const restart = record.compatibility?.upgrade?.restartAgentSession
    ? ' Then restart your agent session.'
    : '';

  return [
    typeof record.error === 'string' && record.error.trim().length > 0
      ? record.error.trim()
      : 'Your PostPlus CLI or PostPlus skills are out of date.',
    `Run: ${updateCommand}.`,
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

// Execution paths must preserve the typed preflight rejection so the CLI can
// recover once. Diagnostics may still use the string formatter above.
export function readPostPlusCompatibilityError(payload: unknown): Error | null {
  if (isPostPlusClientUpgradePayload(payload)) {
    return new PostPlusClientUpgradeRequiredError(payload);
  }
  if (isPostPlusCloudReleaseInProgressPayload(payload)) {
    return new PostPlusCloudReleaseInProgressError(payload);
  }
  return null;
}

export function isPostPlusClientUpgradePayload(
  payload: unknown,
): payload is PostPlusClientUpgradePayload & {
  code: 'postplus_client_upgrade_required';
} {
  return (
    payload !== null &&
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

export class PostPlusCloudReleaseInProgressError extends Error {
  readonly code = 'postplus_cli_cloud_release_in_progress';
  readonly stage = 'compatibility';
  readonly service = 'postplus-cloud';
  readonly retryable = true;
  constructor(payload: unknown) {
    super(formatPostPlusCloudReleaseInProgressError(payload));
    this.name = 'PostPlusCloudReleaseInProgressError';
  }
}
