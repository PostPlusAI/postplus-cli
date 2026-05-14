export const POSTPLUS_SKILLS_REPO = 'PostPlusAI/postplus-skills';
export const POSTPLUS_SKILLS_SOURCE_ENV = 'POSTPLUS_SKILLS_SOURCE';
export const POSTPLUS_SKILLS_CATALOG_URL_ENV = 'POSTPLUS_SKILLS_CATALOG_URL';
export const POSTPLUS_SKILLS_AGENT_TARGETS = [
  'claude-code',
  'codex',
  'cursor',
  'github-copilot',
  'windsurf',
  'trae',
  'trae-cn',
  'openclaw',
  'hermes-agent',
] as const;
const POSTPLUS_SKILLS_AGENT_ARGS = POSTPLUS_SKILLS_AGENT_TARGETS.join(' ');
export const POSTPLUS_SKILLS_INSTALL_COMMAND = formatPostPlusSkillsInstallCommand();
export const POSTPLUS_SKILLS_CURRENT_DIRECTORY_INSTALL_COMMAND =
  formatPostPlusSkillsInstallCommand(
    POSTPLUS_SKILLS_REPO,
    'current-directory',
  );
export const POSTPLUS_SKILLS_LIST_COMMAND = formatPostPlusSkillsListCommand();
export type PostPlusSkillsInstallScope = 'global' | 'current-directory';

const POSTPLUS_SKILLS_INDEX_URL =
  'https://raw.githubusercontent.com/PostPlusAI/postplus-skills/main/skills/INDEX.md';
const POSTPLUS_SKILLS_CATALOG_URL =
  'https://raw.githubusercontent.com/PostPlusAI/postplus-skills/main/skills/catalog.json';

export type PublicSkillCatalogEntry = {
  requirements: PublicSkillRequirements;
  localDependencies: string[];
  skillId: string;
  path: string | null;
};

export const PUBLIC_SKILL_REQUIREMENT_KEYS = [
  'accountConnections',
  'collectionKeys',
  'endpointKeys',
  'hostedCapabilities',
  'localDependencies',
  'modelKeys',
  'sourceKeys',
] as const;

export type PublicSkillRequirementKey =
  (typeof PUBLIC_SKILL_REQUIREMENT_KEYS)[number];

export type PublicSkillRequirements = Record<PublicSkillRequirementKey, string[]>;

export type PublicSkillCatalogReport = {
  source: string;
  releaseId: string;
  indexUrl: string;
  catalogUrl: string;
  installCommand: string;
  listCommand: string;
  skills: PublicSkillCatalogEntry[];
};

export async function loadPublicSkillCatalog(
  fetchFn: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublicSkillCatalogReport> {
  const catalogUrl = resolvePostPlusSkillsCatalogUrl(env);
  const skillsSource = resolvePostPlusSkillsSource(env);
  const response = await fetchFn(catalogUrl, {
    headers: {
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to load PostPlus skill catalog (${response.status}): ${response.statusText}`,
    );
  }

  const raw = await response.text();
  const payload = parseJsonResponse(raw, catalogUrl);
  const catalog = parsePublicSkillCatalog(payload);

  return {
    ...catalog,
    catalogUrl,
    indexUrl: POSTPLUS_SKILLS_INDEX_URL,
    installCommand: formatPostPlusSkillsInstallCommand(skillsSource),
    listCommand: formatPostPlusSkillsListCommand(skillsSource),
    source: skillsSource,
  };
}

export function resolvePostPlusSkillsSource(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[POSTPLUS_SKILLS_SOURCE_ENV]?.trim() || POSTPLUS_SKILLS_REPO;
}

export function resolvePostPlusSkillsCatalogUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[POSTPLUS_SKILLS_CATALOG_URL_ENV]?.trim() || POSTPLUS_SKILLS_CATALOG_URL;
}

export function formatPostPlusSkillsInstallCommand(
  source = POSTPLUS_SKILLS_REPO,
  scope: PostPlusSkillsInstallScope = 'global',
): string {
  const scopeArgs = scope === 'global' ? ' --global' : '';
  return `npx -y skills add ${source}${scopeArgs} --full-depth --skill '*' --agent ${POSTPLUS_SKILLS_AGENT_ARGS} --yes`;
}

export function formatPostPlusSkillsListCommand(
  source = POSTPLUS_SKILLS_REPO,
): string {
  return `npx -y skills add ${source} --list --full-depth`;
}

function parseJsonResponse(raw: string, url: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('<')) {
      throw new Error(
        `PostPlus public skill catalog returned HTML instead of JSON: ${url}`,
      );
    }

    throw new Error(
      error instanceof Error
        ? `PostPlus public skill catalog returned invalid JSON: ${error.message}`
        : 'PostPlus public skill catalog returned invalid JSON.',
    );
  }
}

function parsePublicSkillCatalog(
  payload: unknown,
): Pick<PublicSkillCatalogReport, 'releaseId' | 'skills' | 'source'> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('PostPlus public skill catalog is invalid.');
  }

  const record = payload as Record<string, unknown>;
  const releaseId =
    typeof record.releaseId === 'string' && record.releaseId.trim()
      ? record.releaseId.trim()
      : null;
  const source =
    typeof record.source === 'string' && record.source.trim()
      ? record.source.trim()
      : null;

  if (
    record.schemaVersion !== 1 ||
    source !== POSTPLUS_SKILLS_REPO ||
    !releaseId
  ) {
    throw new Error('PostPlus public skill catalog metadata is invalid.');
  }

  if (!Array.isArray(record.skills)) {
    throw new Error('PostPlus public skill catalog has no skills array.');
  }

  const skills = record.skills.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('PostPlus public skill catalog has an invalid skill.');
    }

    const skill = value as Record<string, unknown>;
    const skillId =
      typeof skill.name === 'string' && skill.name.trim()
        ? skill.name.trim()
        : null;
    const path =
      typeof skill.path === 'string' && skill.path.trim()
        ? skill.path.trim()
        : null;
    const requirements = parsePublicSkillRequirements(skill.requirements);

    const status = typeof skill.status === 'string' ? skill.status.trim() : '';

    if (
      !skillId ||
      !path ||
      !(status === 'released' || status.startsWith('released/'))
    ) {
      throw new Error('PostPlus public skill catalog has an invalid skill.');
    }

    return {
      localDependencies: requirements.localDependencies,
      skillId,
      path,
      requirements,
    };
  });

  if (skills.length === 0) {
    throw new Error(
      'PostPlus public skill catalog is invalid: no released skills were found.',
    );
  }

  return {
    releaseId,
    skills,
    source,
  };
}

function parsePublicSkillRequirements(value: unknown): PublicSkillRequirements {
  if (value === undefined) {
    return createEmptyRequirements();
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      'PostPlus public skill catalog has invalid skill requirements.',
    );
  }

  const record = value as Record<string, unknown>;
  const requirements = createEmptyRequirements();

  for (const key of PUBLIC_SKILL_REQUIREMENT_KEYS) {
    const raw = record[key];

    if (raw === undefined) {
      continue;
    }

    if (!Array.isArray(raw)) {
      throw new Error(
        `PostPlus public skill catalog has invalid ${key} requirements.`,
      );
    }

    requirements[key] = raw.map((item) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error(
          `PostPlus public skill catalog has invalid ${key} requirements.`,
        );
      }

      return item.trim();
    });
  }

  return requirements;
}

function createEmptyRequirements(): PublicSkillRequirements {
  return {
    accountConnections: [],
    collectionKeys: [],
    endpointKeys: [],
    hostedCapabilities: [],
    localDependencies: [],
    modelKeys: [],
    sourceKeys: [],
  };
}
