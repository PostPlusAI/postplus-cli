export const POSTPLUS_SKILLS_REPO = 'PostPlusAI/postplus-skills';
export const POSTPLUS_SKILLS_AGENT_TARGETS = [
  'claude-code',
  'codex',
  'cursor',
  'github-copilot',
  'windsurf',
  'trae',
  'trae-cn',
] as const;
const POSTPLUS_SKILLS_AGENT_ARGS = POSTPLUS_SKILLS_AGENT_TARGETS.join(' ');
export const POSTPLUS_SKILLS_INSTALL_COMMAND = `npx -y skills add PostPlusAI/postplus-skills --global --full-depth --skill '*' --agent ${POSTPLUS_SKILLS_AGENT_ARGS} --yes`;
export const POSTPLUS_SKILLS_LIST_COMMAND =
  'npx -y skills add PostPlusAI/postplus-skills --list --full-depth';

const POSTPLUS_SKILLS_INDEX_URL =
  'https://raw.githubusercontent.com/PostPlusAI/postplus-skills/main/skills/INDEX.md';
const POSTPLUS_SKILLS_CATALOG_URL =
  'https://raw.githubusercontent.com/PostPlusAI/postplus-skills/main/skills/catalog.json';

export type PublicSkillCatalogEntry = {
  localDependencies: string[];
  skillId: string;
  path: string | null;
};

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
): Promise<PublicSkillCatalogReport> {
  const response = await fetchFn(POSTPLUS_SKILLS_CATALOG_URL, {
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
  const payload = parseJsonResponse(raw, POSTPLUS_SKILLS_CATALOG_URL);
  const catalog = parsePublicSkillCatalog(payload);

  return {
    ...catalog,
    catalogUrl: POSTPLUS_SKILLS_CATALOG_URL,
    indexUrl: POSTPLUS_SKILLS_INDEX_URL,
    installCommand: POSTPLUS_SKILLS_INSTALL_COMMAND,
    listCommand: POSTPLUS_SKILLS_LIST_COMMAND,
  };
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
    const requirements =
      skill.requirements &&
      typeof skill.requirements === 'object' &&
      !Array.isArray(skill.requirements)
        ? (skill.requirements as Record<string, unknown>)
        : {};
    const localDependencies = Array.isArray(requirements.localDependencies)
      ? requirements.localDependencies
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean)
      : [];

    const status = typeof skill.status === 'string' ? skill.status.trim() : '';

    if (
      !skillId ||
      !path ||
      !(status === 'released' || status.startsWith('released/'))
    ) {
      throw new Error('PostPlus public skill catalog has an invalid skill.');
    }

    return {
      localDependencies,
      skillId,
      path,
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
