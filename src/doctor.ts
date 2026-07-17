import { formatAccountBindingName } from './account-binding-display.js';
import {
  type FreshRemoteAuth,
  resolveFreshRemoteAuth,
} from './auth-session.js';
import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import { formatPostPlusCompatibilityError } from './client-compatibility.js';
import { resolveHostedBaseUrl } from './hosted-release.js';
import {
  formatLocalDependencyReport,
  generateLocalDependencyReport,
} from './local-dependencies.js';
import {
  type PublicSkillCatalogEntry,
  type PublicSkillCatalogReport,
  type PublicSkillRequirements,
  loadPublicSkillCatalog,
} from './skill-catalog.js';
import { readSubscriptionStatusField } from './subscription-status.js';

export type DoctorCheck = {
  id:
    | 'client_compatibility'
    | 'hosted_base_url'
    | 'hosted_capabilities'
    | 'local_dependencies'
    | 'remote_auth'
    | 'skill_catalog';
  label: string;
  // `degraded`: the check's hosted route/key exists and is released, but a
  // field-level contract dimension reported by hosted readiness is a known
  // coverage gap. It does not fail required readiness; it is surfaced distinctly.
  status: 'degraded' | 'fail' | 'pass';
  severity: 'required' | 'task_specific';
  detail: string;
  fix?: string;
  metadata?: DoctorCheckMetadata;
};

export type DoctorCheckMetadata = {
  bootstrapRule?: string;
  missingDependencies?: {
    dependency: string;
    detail: string;
    skillIds: string[];
  }[];
};

export type DoctorReport = {
  // Bumped to 3 when client compatibility became distinct from remote auth so
  // agents/automation do not prescribe login for CLI or skills version errors.
  schemaVersion: 3;
  ok: boolean;
  requiredOk: boolean;
  checks: DoctorCheck[];
  skillId?: string;
};

export type DoctorReportOptions = {
  skillId?: string;
};

type SkillScope = {
  catalog: PublicSkillCatalogReport;
  skill: PublicSkillCatalogEntry;
};

function createPass(
  id: DoctorCheck['id'],
  label: string,
  detail: string,
  severity: DoctorCheck['severity'] = 'required',
): DoctorCheck {
  return {
    id,
    label,
    status: 'pass',
    severity,
    detail,
  };
}

function createFail(
  id: DoctorCheck['id'],
  label: string,
  detail: string,
  fix?: string,
  input: {
    severity?: DoctorCheck['severity'];
    metadata?: DoctorCheckMetadata;
  } = {},
): DoctorCheck {
  return {
    id,
    label,
    status: 'fail',
    severity: input.severity ?? 'required',
    detail,
    fix,
    metadata: input.metadata,
  };
}

// A check whose hosted route/key is released but has a known field-level coverage
// gap. It is not a required failure (does not break `requiredOk`); it is surfaced
// so the gap is visible instead of a blanket pass.
function createDegraded(
  id: DoctorCheck['id'],
  label: string,
  detail: string,
  fix?: string,
  input: {
    severity?: DoctorCheck['severity'];
  } = {},
): DoctorCheck {
  return {
    id,
    label,
    status: 'degraded',
    severity: input.severity ?? 'required',
    detail,
    fix,
  };
}

export async function generateDoctorReport(
  options: DoctorReportOptions = {},
): Promise<DoctorReport> {
  const hostedBaseUrl = await resolveHostedBaseUrl();
  const checks: DoctorCheck[] = [
    createPass(
      'hosted_base_url',
      'PostPlus Cloud',
      `Using ${hostedBaseUrl ?? 'https://postplus.io'}`,
    ),
  ];
  const skillScope = await resolveSkillScope(options.skillId);
  if (skillScope) {
    checks.push(
      createPass(
        'skill_catalog',
        'Skill selection',
        `Using ${skillScope.skill.skillId} from catalog ${skillScope.catalog.releaseId}`,
      ),
    );
  }

  checks.push(await checkLocalDependencies(skillScope));

  if (!hostedBaseUrl) {
    checks.push(
      createFail(
        'remote_auth',
        'Remote auth',
        'PostPlus Cloud base URL could not be resolved.',
        'Configure POSTPLUS_API_BASE_URL or run `postplus auth login`.',
      ),
    );
    return buildDoctorReport(checks);
  }

  const auth = await resolveFreshRemoteAuth().catch((error: unknown) => {
    const message =
      error instanceof Error
        ? error.message
        : 'No PostPlus CLI session is configured.';

    checks.push(
      createFail(
        'remote_auth',
        'Remote auth',
        message,
        'Run `postplus auth login`.',
      ),
    );

    return null;
  });

  if (!auth) {
    return buildDoctorReport(checks);
  }

  const authCheck = await checkRemoteAuth(auth);
  checks.push(authCheck);

  if (authCheck.status === 'pass') {
    checks.push(await checkHostedCapabilities(auth, skillScope));
  }

  return buildDoctorReport(checks, options.skillId);
}

async function resolveSkillScope(skillId?: string): Promise<SkillScope | null> {
  if (!skillId) {
    return null;
  }

  const catalog = await loadPublicSkillCatalog();
  const skill = catalog.skills.find((entry) => entry.skillId === skillId);

  if (!skill) {
    throw new Error(
      `Unknown PostPlus skill: ${skillId}. Run \`postplus list\` to see released skill ids.`,
    );
  }

  return { catalog, skill };
}

async function checkLocalDependencies(
  skillScope: SkillScope | null,
): Promise<DoctorCheck> {
  try {
    const report = await generateLocalDependencyReport(
      skillScope
        ? {
            loadCatalog: async () => ({
              ...skillScope.catalog,
              skills: [skillScope.skill],
            }),
          }
        : {},
    );
    const detail = formatLocalDependencyReport(report);

    if (!report.ok) {
      const skillId = skillScope?.skill.skillId;
      return createFail(
        'local_dependencies',
        skillId
          ? `Local dependencies for ${skillId}`
          : 'Task-specific local media dependencies',
        detail,
        skillId
          ? 'Run the selected PostPlus skill in a local agent. The installed postplus-shared rules tell the agent how to bootstrap approved missing dependencies.'
          : 'Run the affected PostPlus skill in a local agent. The installed postplus-shared rules tell the agent how to bootstrap approved missing media dependencies.',
        {
          severity: skillId ? 'required' : 'task_specific',
          metadata: {
            bootstrapRule: 'postplus-shared',
            missingDependencies: report.checks
              .filter((check) => !check.ok)
              .map((check) => ({
                dependency: check.dependency,
                detail: check.detail,
                skillIds: check.skillIds,
              })),
          },
        },
      );
    }

    return createPass(
      'local_dependencies',
      skillScope
        ? `Local dependencies for ${skillScope.skill.skillId}`
        : 'Local dependencies',
      detail,
    );
  } catch (error) {
    return createFail(
      'local_dependencies',
      'Local dependencies',
      error instanceof Error
        ? error.message
        : 'Failed to check local dependencies.',
    );
  }
}

function buildDoctorReport(
  checks: DoctorCheck[],
  skillId?: string,
): DoctorReport {
  // A degraded required check is a known coverage gap, not a failure: it keeps
  // `requiredOk` true but `ok` false (doctor is not a clean pass while a gap
  // exists), mirroring how task-specific warnings surface without failing.
  const requiredOk = checks.every(
    (check) => check.severity !== 'required' || check.status !== 'fail',
  );

  return {
    schemaVersion: 3,
    ok: checks.every((check) => check.status === 'pass'),
    requiredOk,
    checks,
    ...(skillId ? { skillId } : {}),
  };
}

async function checkRemoteAuth(input: FreshRemoteAuth): Promise<DoctorCheck> {
  try {
    const response = await sendAuthedCloudRequest({
      auth: input,
      pathName: '/api/postplus-cli/auth/whoami',
      retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
    });

    const payload = (await response.json()) as {
      accountId?: unknown;
      accountName?: unknown;
      accountType?: unknown;
      error?: unknown;
      subscriptionStatus?: unknown;
      userEmail?: unknown;
      userId?: unknown;
    };

    if (!response.ok) {
      const compatibilityCheck = createClientCompatibilityFailure(payload);

      if (compatibilityCheck) {
        return compatibilityCheck;
      }

      return createFail(
        'remote_auth',
        'Remote auth',
        readErrorMessage(payload, 'PostPlus Cloud rejected the CLI session.'),
        'Run `postplus auth login`.',
      );
    }

    const accountId =
      typeof payload.accountId === 'string' ? payload.accountId : 'unknown';
    const accountName =
      typeof payload.accountName === 'string' ? payload.accountName : null;
    const accountType =
      payload.accountType === 'personal' || payload.accountType === 'team'
        ? payload.accountType
        : null;
    const user =
      typeof payload.userEmail === 'string'
        ? payload.userEmail
        : typeof payload.userId === 'string'
          ? payload.userId
          : 'unknown';
    const subscription = readSubscriptionStatusField(payload).label;

    return createPass(
      'remote_auth',
      'Remote auth',
      `${formatAccountBindingName({
        accountId,
        accountName,
        accountType,
      })}; account ${accountId}; user ${user}; subscription ${subscription}`,
    );
  } catch (error) {
    return createFail(
      'remote_auth',
      'Remote auth',
      error instanceof Error
        ? error.message
        : 'Failed to validate PostPlus Cloud auth.',
      'Run `postplus auth validate` after confirming network access.',
    );
  }
}

async function checkHostedCapabilities(
  input: FreshRemoteAuth,
  skillScope: SkillScope | null,
): Promise<DoctorCheck> {
  try {
    const response = await sendAuthedCloudRequest({
      auth: input,
      pathName: '/api/postplus-cli/hosted/readiness',
      retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
    });

    const payload = (await response.json()) as {
      capabilities?: unknown;
      error?: unknown;
      ok?: unknown;
      subscriptionActive?: unknown;
      subscriptionStatus?: unknown;
    };

    if (!response.ok) {
      const compatibilityCheck = createClientCompatibilityFailure(payload);

      if (compatibilityCheck) {
        return compatibilityCheck;
      }

      return createFail(
        'hosted_capabilities',
        'Hosted capabilities',
        readErrorMessage(
          payload,
          'PostPlus Cloud hosted readiness check failed.',
        ),
      );
    }

    const capabilities = readHostedCapabilityEntries(payload.capabilities);
    const relevantCapabilities = skillScope
      ? filterCapabilitiesForSkill(capabilities, skillScope.skill.requirements)
      : capabilities;
    const failedLabels = relevantCapabilities
      .map((value) => readCapabilityFailureLabel(value, skillScope))
      .filter((value): value is string => value !== null);

    if (skillScope && hasHostedRequirements(skillScope.skill.requirements)) {
      const subscription = readSubscriptionStatusField(payload).label;
      if (
        requiresSocialPublishingPlan(skillScope.skill.requirements) &&
        subscription === 'none'
      ) {
        failedLabels.push(
          `PostPlus Plus or Pro plan required; current subscription ${subscription}`,
        );
      }

      const missingRequirements = collectMissingHostedRequirementLabels(
        relevantCapabilities,
        skillScope.skill.requirements,
      );
      failedLabels.push(...missingRequirements);
    }

    if (
      failedLabels.length > 0 ||
      (!skillScope && payload.ok !== true && capabilities.length === 0)
    ) {
      const skillId = skillScope?.skill.skillId;
      return createFail(
        'hosted_capabilities',
        skillId ? `Hosted capabilities for ${skillId}` : 'Hosted capabilities',
        `Not ready: ${failedLabels.join(', ') || 'unknown capability failure'}`,
        'Check PostPlus Cloud provider configuration and subscription state.',
        {
          severity: skillId ? 'required' : 'task_specific',
        },
      );
    }

    const subscription = readSubscriptionStatusField(payload).label;

    const degradedLabels = relevantCapabilities
      .map((value) => readCapabilityDegradedLabel(value, skillScope))
      .filter((value): value is string => value !== null);

    if (degradedLabels.length > 0) {
      const skillId = skillScope?.skill.skillId;
      return createDegraded(
        'hosted_capabilities',
        skillId ? `Hosted capabilities for ${skillId}` : 'Hosted capabilities',
        `Ready with field-level coverage gaps: ${degradedLabels.join(', ')}; subscription ${subscription}`,
        'These hosted routes are released but have a known field-level contract gap. Track the readiness convergence plan before relying on field-level validation for these endpoints.',
        {
          severity: skillId ? 'required' : 'task_specific',
        },
      );
    }

    return createPass(
      'hosted_capabilities',
      skillScope
        ? `Hosted capabilities for ${skillScope.skill.skillId}`
        : 'Hosted capabilities',
      `Ready (${relevantCapabilities.length} capability checks passed; subscription ${subscription})`,
    );
  } catch (error) {
    return createFail(
      'hosted_capabilities',
      'Hosted capabilities',
      error instanceof Error
        ? error.message
        : 'Failed to check hosted capability readiness.',
    );
  }
}

function createClientCompatibilityFailure(
  payload: unknown,
): DoctorCheck | null {
  const compatibilityError = formatPostPlusCompatibilityError(payload);

  if (!compatibilityError) {
    return null;
  }

  return createFail(
    'client_compatibility',
    'Client compatibility',
    compatibilityError,
  );
}

function readHostedCapabilityEntries(
  value: unknown,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === 'object' && !Array.isArray(entry),
  );
}

function readCapabilityFailureLabel(
  value: Record<string, unknown>,
  skillScope: SkillScope | null,
): string | null {
  if (!value || typeof value !== 'object') {
    return 'invalid capability response';
  }

  const record = value;
  if (record.ok === true || record.required === false) {
    return null;
  }

  const label =
    typeof record.label === 'string'
      ? record.label
      : typeof record.id === 'string'
        ? record.id
        : 'unknown capability';
  const failedChecks = Array.isArray(record.checks)
    ? record.checks
        .map(readReadinessCheckFailureLabel)
        .filter((check): check is string => check !== null)
    : [];

  const labelWithFailures =
    failedChecks.length > 0 ? `${label} (${failedChecks.join(', ')})` : label;

  return skillScope
    ? `${labelWithFailures} for ${skillScope.skill.skillId}`
    : labelWithFailures;
}

function readReadinessCheckFailureLabel(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return 'invalid readiness check';
  }

  const record = value as Record<string, unknown>;
  if (record.ok === true || record.required === false) {
    return null;
  }

  return typeof record.label === 'string'
    ? record.label
    : typeof record.id === 'string'
      ? record.id
      : 'unknown check';
}

// Surfaces a capability whose checks include a `degraded` field-level dimension.
// Degraded checks keep `ok` true (they do not fail the capability), so the
// failure reader skips them; this reader reports the gap separately.
function readCapabilityDegradedLabel(
  value: Record<string, unknown>,
  skillScope: SkillScope | null,
): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (value.required === false) {
    return null;
  }

  const degradedChecks = Array.isArray(value.checks)
    ? value.checks
        .map(readReadinessCheckDegradedLabel)
        .filter((check): check is string => check !== null)
    : [];

  if (degradedChecks.length === 0) {
    return null;
  }

  const label =
    typeof value.label === 'string'
      ? value.label
      : typeof value.id === 'string'
        ? value.id
        : 'unknown capability';
  const labelWithChecks = `${label} (${degradedChecks.join(', ')})`;

  return skillScope
    ? `${labelWithChecks} for ${skillScope.skill.skillId}`
    : labelWithChecks;
}

function readReadinessCheckDegradedLabel(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.status !== 'degraded') {
    return null;
  }

  return typeof record.label === 'string'
    ? record.label
    : typeof record.id === 'string'
      ? record.id
      : 'unknown check';
}

function filterCapabilitiesForSkill(
  capabilities: Record<string, unknown>[],
  requirements: PublicSkillRequirements,
): Record<string, unknown>[] {
  if (!hasHostedRequirements(requirements)) {
    return [];
  }

  return capabilities.filter((capability) =>
    capabilityMatchesRequirements(capability, requirements),
  );
}

function capabilityMatchesRequirements(
  capability: Record<string, unknown>,
  requirements: PublicSkillRequirements,
): boolean {
  const identifiers = collectCapabilityIdentifiers(capability);
  const hostedCapabilities = new Set(requirements.hostedCapabilities);
  const requirementKeys = collectHostedRequirementKeys(requirements);

  return identifiers.some((identifier) => {
    if (
      identifier === 'media-file:upload' &&
      hostedCapabilities.has('media-file') &&
      !requiresHostedMediaFileUpload(requirements)
    ) {
      return false;
    }

    const [prefix, suffix] = splitCapabilityIdentifier(identifier);

    if (
      prefix === 'media-file' &&
      suffix &&
      suffix !== 'upload' &&
      hostedCapabilities.has('media-file')
    ) {
      return true;
    }

    if (hostedCapabilities.has(identifier)) {
      return true;
    }

    if (
      prefix &&
      suffix &&
      hostedCapabilities.has(prefix) &&
      (isWholeFamilyHostedCapability(prefix) || requirementKeys.has(suffix))
    ) {
      return true;
    }

    return requirementKeys.has(identifier) || requirementKeys.has(suffix);
  });
}

function requiresHostedMediaFileUpload(
  requirements: PublicSkillRequirements,
): boolean {
  return (
    requirements.hostedCapabilities.includes('media-generation') ||
    requirements.endpointKeys.length > 0
  );
}

function collectCapabilityIdentifiers(
  capability: Record<string, unknown>,
): string[] {
  const identifiers = new Set<string>();

  for (const key of [
    'id',
    'key',
    'capability',
    'capabilityKey',
    'collectionKey',
    'endpointKey',
    'modelKey',
    'sourceKey',
    'accountConnection',
  ]) {
    const value = capability[key];
    if (typeof value === 'string' && value.trim()) {
      identifiers.add(value.trim());
    }
  }

  if (Array.isArray(capability.checks)) {
    for (const check of capability.checks) {
      if (!check || typeof check !== 'object' || Array.isArray(check)) {
        continue;
      }

      for (const identifier of collectCapabilityIdentifiers(
        check as Record<string, unknown>,
      )) {
        identifiers.add(identifier);
      }
    }
  }

  return [...identifiers];
}

function collectHostedRequirementKeys(
  requirements: PublicSkillRequirements,
): Set<string> {
  return new Set([
    ...requirements.accountConnections,
    ...requirements.collectionKeys,
    ...requirements.endpointKeys,
    ...requirements.modelKeys,
    ...requirements.sourceKeys,
  ]);
}

// Capability families whose sub-keys are intentionally NOT expressible as catalog
// requirement keys: a skill requires the bare family capability, and any released
// sub-key readiness row satisfies it. social-publishing operations and
// public-content-discovery tools (e.g. web-search) both have no requirement-key
// binding, so requiring the family must match the whole family. Without this,
// `public-content-discovery:web-search` readiness is filtered out for skills that
// require `public-content-discovery`, producing a false "readiness check missing".
function isWholeFamilyHostedCapability(prefix: string): boolean {
  return prefix === 'public-content-discovery' || prefix === 'social-publishing';
}

function requiresSocialPublishingPlan(
  requirements: PublicSkillRequirements,
): boolean {
  return requirements.hostedCapabilities.includes('social-publishing');
}

function hasHostedRequirements(requirements: PublicSkillRequirements): boolean {
  return (
    requirements.accountConnections.length > 0 ||
    requirements.collectionKeys.length > 0 ||
    requirements.endpointKeys.length > 0 ||
    requirements.hostedCapabilities.length > 0 ||
    requirements.modelKeys.length > 0 ||
    requirements.sourceKeys.length > 0
  );
}

function collectMissingHostedRequirementLabels(
  capabilities: Record<string, unknown>[],
  requirements: PublicSkillRequirements,
): string[] {
  const availableIdentifiers = new Set(
    capabilities.flatMap(collectCapabilityIdentifiers),
  );
  const missing: string[] = [];

  for (const capability of requirements.hostedCapabilities) {
    if (
      ![...availableIdentifiers].some((identifier) =>
        identifierMatchesCapability(identifier, capability),
      )
    ) {
      missing.push(capability);
    }
  }

  for (const key of collectHostedRequirementKeys(requirements)) {
    if (
      ![...availableIdentifiers].some((identifier) =>
        identifierMatchesKey(identifier, key),
      )
    ) {
      missing.push(key);
    }
  }

  return missing.map((value) => `${value} readiness check missing`);
}

function identifierMatchesKey(identifier: string, key: string): boolean {
  if (identifier === key) {
    return true;
  }

  if (
    key === 'social-publishing-workspace' &&
    identifierMatchesCapability(identifier, 'social-publishing')
  ) {
    return true;
  }

  const [, suffix] = splitCapabilityIdentifier(identifier);
  return suffix === key;
}

function identifierMatchesCapability(
  identifier: string,
  capability: string,
): boolean {
  if (identifier === capability) {
    return true;
  }

  const [prefix] = splitCapabilityIdentifier(identifier);
  return prefix === capability;
}

function splitCapabilityIdentifier(
  identifier: string,
): [string | null, string] {
  const index = identifier.indexOf(':');

  if (index === -1) {
    return [null, identifier];
  }

  return [identifier.slice(0, index), identifier.slice(index + 1)];
}

function readErrorMessage(
  payload: { code?: unknown; compatibility?: unknown; error?: unknown },
  fallback: string,
): string {
  const compatibilityError = formatPostPlusCompatibilityError(payload);

  if (compatibilityError) {
    return compatibilityError;
  }

  return typeof payload.error === 'string' && payload.error.trim().length > 0
    ? payload.error
    : fallback;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['PostPlus CLI doctor', ''];

  for (const check of report.checks) {
    const marker =
      check.status === 'pass'
        ? '[PASS]'
        : check.status === 'degraded'
          ? '[DEGRADED]'
          : check.severity === 'task_specific'
            ? '[WARN]'
            : '[FAIL]';
    lines.push(`${marker} ${check.label}: ${check.detail}`);
    if (check.fix) {
      lines.push(`  Fix: ${check.fix}`);
    }
  }

  const hasDegraded = report.checks.some(
    (check) => check.status === 'degraded',
  );

  lines.push(
    '',
    report.ok
      ? 'Doctor passed.'
      : report.requiredOk
        ? hasDegraded
          ? 'Doctor incomplete: hosted readiness has known field-level coverage gaps.'
          : 'Doctor incomplete: task-specific checks need attention.'
        : 'Doctor failed.',
  );

  return lines.join('\n');
}
