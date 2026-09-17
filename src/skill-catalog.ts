import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUNDLED_SKILLS_ROOT, readSkillsManifest, SkillsBundleError } from './skills-bundle.js';
import { fetchWithNetworkDiagnostics } from './network-diagnostics.js';

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
export const POSTPLUS_SKILLS_INSTALL_COMMAND = formatPostPlusSkillsInstallCommand();
export const POSTPLUS_SKILLS_CURRENT_DIRECTORY_INSTALL_COMMAND =
  formatPostPlusSkillsInstallCommand(
    POSTPLUS_SKILLS_REPO,
    'current-directory',
  );
export const POSTPLUS_SKILLS_LIST_COMMAND = formatPostPlusSkillsListCommand();
export type PostPlusSkillsInstallScope = 'global' | 'current-directory';


export type PublicSkillCatalogEntry = {
  requirements: PublicSkillRequirements;
  localDependencies: string[];
  skillId: string;
  path: string | null;
};

export type PublicReleaseNotes = {
  schemaVersion: 1;
  releaseId: string;
  title: string;
  summary: string;
  highlights: string[];
};

export type PublicProductBrief = {
  schemaVersion: 1;
  paragraphs: string[];
};

export const PUBLIC_SKILL_REQUIREMENT_KEYS = [
  'accountConnections',
  'capabilities',
  'endpointKeys',
  'localDependencies',
  'modelKeys',
  'routeKeys',
] as const;

const PUBLIC_SKILL_CAPABILITIES = new Set([
  'media',
  'publishing',
  'research',
]);

export type PublicSkillRequirementKey =
  (typeof PUBLIC_SKILL_REQUIREMENT_KEYS)[number];

export type PublicSkillRequirements = Record<PublicSkillRequirementKey, string[]>;

export type PublicSkillCatalogReport = {
  source: string;
  releaseId: string;
  catalogUrl: string;
  installCommand: string;
  listCommand: string;
  productBrief?: PublicProductBrief;
  releaseNotes?: PublicReleaseNotes;
  skills: PublicSkillCatalogEntry[];
  contentHashes?: Record<string, string>;
};

export async function loadPublicSkillCatalog(
  fetchFn?: typeof fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PublicSkillCatalogReport> {
  const skillsSource = resolvePostPlusSkillsSource(env);
  const overrideUrl = env[POSTPLUS_SKILLS_CATALOG_URL_ENV]?.trim();
  const catalogUrl = fetchFn && !overrideUrl
    ? 'https://raw.githubusercontent.com/PostPlusAI/postplus-skills/main/skills/catalog.json'
    : resolvePostPlusSkillsCatalogUrl(env);
  let raw: string;
  let contentHashes: Record<string, string> | undefined;
  if (overrideUrl || fetchFn) {
    const request = fetchFn ?? ((url, init) => fetchWithNetworkDiagnostics(String(url), init ?? {}, {
      debug: false, label: 'skills_catalog', redirectPolicy: 'follow-https',
    }));
    const response = await request(catalogUrl, {
      headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Failed to load PostPlus skill catalog (${response.status}): ${response.statusText}`);
    raw = await response.text();
  } else {
    const manifest = await readSkillsManifest(skillsSource);
    raw = await readFile(join(skillsSource, 'skills/catalog.json'), 'utf8');
    contentHashes = Object.fromEntries(manifest.skills.map((skill) => [skill.name, skill.contentHash]));
    const catalog = parsePublicSkillCatalog(parseJsonResponse(raw, catalogUrl));
    if (catalog.releaseId !== manifest.releaseId || catalog.skills.length !== manifest.skills.length ||
        catalog.skills.some((skill) => !manifest.skills.some((entry) => entry.name === skill.skillId && entry.path === skill.path))) {
      throw new SkillsBundleError('The bundled skill catalog does not match its manifest.');
    }
  }
  const catalog = parsePublicSkillCatalog(parseJsonResponse(raw, catalogUrl));
  return {
    ...catalog, catalogUrl,
    ...(contentHashes ? { contentHashes } : {}),
    installCommand: formatPostPlusSkillsInstallCommand(skillsSource),
    listCommand: formatPostPlusSkillsListCommand(skillsSource),
    source: skillsSource,
  };
}

export function resolvePostPlusSkillsSource(env: NodeJS.ProcessEnv = process.env): string {
  return env[POSTPLUS_SKILLS_SOURCE_ENV]?.trim() || BUNDLED_SKILLS_ROOT;
}

export function resolvePostPlusSkillsCatalogUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env[POSTPLUS_SKILLS_CATALOG_URL_ENV]?.trim() ||
    pathToFileURL(join(resolvePostPlusSkillsSource(env), 'skills/catalog.json')).href;
}

export function formatPostPlusSkillsInstallCommand(
  _source = BUNDLED_SKILLS_ROOT,
  scope: PostPlusSkillsInstallScope = 'global',
): string {
  return `postplus install${scope === 'global' ? '' : ' --current-directory'}`;
}

export function formatPostPlusSkillsListCommand(_source = BUNDLED_SKILLS_ROOT): string {
  return 'postplus list';
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
): Pick<
  PublicSkillCatalogReport,
  'productBrief' | 'releaseId' | 'releaseNotes' | 'skills' | 'source'
> {
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
    record.schemaVersion !== 2 ||
    source !== POSTPLUS_SKILLS_REPO ||
    !releaseId
  ) {
    throw new Error('PostPlus public skill catalog metadata is invalid.');
  }

  const releaseNotes = parsePublicReleaseNotes(record.releaseNotes, releaseId);

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

  const productBrief = parsePublicProductBrief(record.productBrief);

  return {
    ...(productBrief ? { productBrief } : {}),
    releaseId,
    ...(releaseNotes ? { releaseNotes } : {}),
    skills,
    source,
  };
}

function parsePublicProductBrief(value: unknown): PublicProductBrief | null {
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PostPlus public skill catalog has invalid product brief.');
  }

  const record = value as Record<string, unknown>;
  const paragraphs = record.paragraphs;
  if (
    record.schemaVersion !== 1 ||
    !Array.isArray(paragraphs) ||
    paragraphs.length === 0 ||
    paragraphs.length > 12 ||
    paragraphs.some(
      (paragraph) =>
        typeof paragraph !== 'string' ||
        !paragraph.trim() ||
        paragraph.length > 2000,
    )
  ) {
    throw new Error('PostPlus public skill catalog has invalid product brief.');
  }

  return {
    schemaVersion: 1,
    paragraphs: paragraphs.map((paragraph) => (paragraph as string).trim()),
  };
}

function parsePublicReleaseNotes(
  value: unknown,
  expectedReleaseId: string,
): PublicReleaseNotes | null {
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PostPlus public skill catalog has invalid release notes.');
  }

  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.releaseId !== expectedReleaseId ||
    typeof record.title !== 'string' ||
    !record.title.trim() ||
    typeof record.summary !== 'string' ||
    !record.summary.trim() ||
    !Array.isArray(record.highlights) ||
    record.highlights.length === 0 ||
    record.highlights.some(
      (highlight) => typeof highlight !== 'string' || !highlight.trim(),
    )
  ) {
    throw new Error('PostPlus public skill catalog has invalid release notes.');
  }

  return {
    schemaVersion: 1,
    releaseId: expectedReleaseId,
    title: record.title.trim(),
    summary: record.summary.trim(),
    highlights: record.highlights.map((highlight) =>
      (highlight as string).trim(),
    ),
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
  const unknownKeys = Object.keys(record).filter(
    (key) =>
      !PUBLIC_SKILL_REQUIREMENT_KEYS.includes(
        key as PublicSkillRequirementKey,
      ),
  );

  if (unknownKeys.length > 0) {
    throw new Error(
      `PostPlus public skill catalog has unsupported requirements: ${unknownKeys.join(', ')}.`,
    );
  }

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

    if (
      key === 'capabilities' &&
      requirements[key].some(
        (capability) => !PUBLIC_SKILL_CAPABILITIES.has(capability),
      )
    ) {
      throw new Error(
        'PostPlus public skill catalog has unsupported capabilities.',
      );
    }
  }

  return requirements;
}

function createEmptyRequirements(): PublicSkillRequirements {
  return {
    accountConnections: [],
    capabilities: [],
    endpointKeys: [],
    localDependencies: [],
    modelKeys: [],
    routeKeys: [],
  };
}
