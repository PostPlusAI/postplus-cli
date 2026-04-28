import { createHash } from 'node:crypto';
import { existsSync, constants as fsConstants } from 'node:fs';
import { access, lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';

export type SkillCatalogEntry = {
  skillId: string;
  sourceDir: string;
  skillFile: string;
  displayName: string;
  description: string | null;
};

type SkillRegistry = {
  sharedRulebooks?: Array<{
    path?: string;
  }>;
  families?: Array<{
    releaseSupportPaths?: string[];
    skills?: Array<{
      name?: string;
      path?: string;
      releaseSupportPaths?: string[];
      status?: string;
    }>;
  }>;
};

export type ReleaseManifestSkill = {
  skillId: string;
  displayName: string;
  description: string | null;
  publishedVersion: string | null;
  integrity: string;
  fileCount: number;
};

export type ReleaseManifestMessage = {
  id: string;
  kind: 'marketing' | 'release';
  body: string;
  ctaLabel?: string | null;
  ctaUrl?: string | null;
  title?: string | null;
};

export type ReleaseManifest = {
  formatVersion: 1;
  messages?: ReleaseManifestMessage[];
  skillCount: number;
  skills: ReleaseManifestSkill[];
};

export type ReleaseSkillBundleFile = {
  path: string;
  size: number;
  sha256: string;
  contentBase64: string;
};

export type ReleaseSkillBundle = {
  skillId: string;
  displayName: string;
  description: string | null;
  publishedVersion: string | null;
  integrity: string;
  files: ReleaseSkillBundleFile[];
};

type SkillBundleFileMetadata = {
  absolutePath: string;
  relativePath: string;
  size: number;
  sha256: string;
};

type SkillsRepoLayout = {
  repoRoot: string;
  bundleRoot: string;
  registryPath: string;
  skillsRoot: string;
};

const IMPORT_FILE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

const IMPORT_SPECIFIER_PATTERN =
  /(?:import\s+(?:[^'"]+?\s+from\s+)?|export\s+[^'"]+?\s+from\s+|import\s*\()\s*["']([^"']+)["']/g;
const MARKDOWN_CODE_PATH_PATTERN = /`([^`\n]+)`/g;

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---\n')) {
    return {};
  }

  const endIndex = content.indexOf('\n---\n', 4);
  if (endIndex < 0) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const line of content.slice(4, endIndex).split('\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');

    if (key.length > 0 && value.length > 0) {
      result[key] = value;
    }
  }

  return result;
}

function parseHeading(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || null;
}

function createSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function createBundleIntegrity(files: SkillBundleFileMetadata[]): string {
  const hash = createHash('sha256');

  for (const file of files) {
    hash.update(file.relativePath, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(file.sha256, 'utf8');
    hash.update('\n', 'utf8');
  }

  return `sha256:${hash.digest('hex')}`;
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isReleaseReadySkillStatus(status: string | undefined): boolean {
  if (!status) {
    return false;
  }

  if (status.startsWith('blocked/')) {
    return false;
  }

  return !status.includes('/experimental');
}

async function resolveSkillsRepoLayout(
  repoRoot: string,
): Promise<SkillsRepoLayout | null> {
  const standalone = {
    repoRoot,
    bundleRoot: repoRoot,
    registryPath: resolve(repoRoot, 'skills', 'registry.json'),
    skillsRoot: resolve(repoRoot, 'skills'),
  };

  return (await pathExists(standalone.registryPath)) ? standalone : null;
}

async function requireSkillsRepoLayout(
  repoRoot: string,
): Promise<SkillsRepoLayout> {
  const layout = await resolveSkillsRepoLayout(repoRoot);

  if (!layout) {
    throw new Error(
      `Could not locate a PostPlus skills repository from ${repoRoot}.`,
    );
  }

  return layout;
}

async function loadReleaseReadySkillIdsFromRegistry(repoRoot: string): Promise<
  Map<
    string,
    {
      releaseSupportPaths: string[];
    }
  >
> {
  const { registryPath } = await requireSkillsRepoLayout(repoRoot);
  const raw = await readFile(registryPath, 'utf8');
  const registry = JSON.parse(raw) as SkillRegistry;
  const sharedRulebookPaths = Array.from(
    new Set(
      (registry.sharedRulebooks ?? [])
        .map((entry) => entry.path?.trim() ?? '')
        .filter((entry) => entry.length > 0),
    ),
  );
  const releaseReadySkills = new Map<
    string,
    {
      releaseSupportPaths: string[];
    }
  >();

  for (const family of registry.families ?? []) {
    const familyReleaseSupportPaths = Array.from(
      new Set(
        (family.releaseSupportPaths ?? [])
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),
    );

    for (const skill of family.skills ?? []) {
      if (!isReleaseReadySkillStatus(skill.status)) {
        continue;
      }

      const relativePath = skill.path?.trim();
      if (!relativePath) {
        continue;
      }

      const skillId = basename(dirname(relativePath));
      if (skillId.length > 0) {
        releaseReadySkills.set(skillId, {
          releaseSupportPaths: Array.from(
            new Set(
              [
                ...sharedRulebookPaths,
                ...familyReleaseSupportPaths,
                ...(skill.releaseSupportPaths ?? [])
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0),
              ].filter((entry) => entry.length > 0),
            ),
          ),
        });
      }
    }
  }

  return releaseReadySkills;
}

async function listFilesRecursively(currentDir: string): Promise<string[]> {
  const stats = await lstat(currentDir);

  if (stats.isSymbolicLink()) {
    throw new Error(
      `Unsupported symbolic link inside released skill bundle: ${currentDir}`,
    );
  }

  if (stats.isFile()) {
    return [currentDir];
  }

  const entries = await readdir(currentDir, {
    withFileTypes: true,
  });
  const sortedEntries = entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files: string[] = [];

  for (const entry of sortedEntries) {
    const absolutePath = resolve(currentDir, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(
        `Unsupported symbolic link inside released skill bundle: ${absolutePath}`,
      );
    }

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        throw new Error(
          `Unsupported node_modules directory inside released skill bundle: ${absolutePath}`,
        );
      }

      files.push(...(await listFilesRecursively(absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push(absolutePath);
  }

  return files;
}

async function readPublishedVersion(sourceDir: string): Promise<string | null> {
  const metaPath = resolve(sourceDir, '_meta.json');

  try {
    const raw = await readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

async function loadSkillBundleMetadata(
  bundleRoot: string,
  sources: string[],
  input?: {
    primarySourceDir?: string;
    skillId?: string;
  },
): Promise<SkillBundleFileMetadata[]> {
  const files = new Map<string, SkillBundleFileMetadata>();

  for (const sourcePath of sources) {
    const absoluteFiles = await listFilesRecursively(sourcePath);

    for (const absolutePath of absoluteFiles) {
      const buffer = await readFile(absolutePath);
      const relativePath = buildBundleRelativePath({
        absolutePath,
        bundleRoot,
        primarySourceDir: input?.primarySourceDir ?? null,
        skillId: input?.skillId ?? null,
      });

      files.set(relativePath, {
        absolutePath,
        relativePath,
        size: buffer.byteLength,
        sha256: createSha256(buffer),
      });
    }
  }

  return [...files.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function buildBundleRelativePath(input: {
  absolutePath: string;
  bundleRoot: string;
  primarySourceDir: string | null;
  skillId: string | null;
}) {
  if (
    input.primarySourceDir &&
    input.skillId &&
    isWithinPath(input.absolutePath, input.primarySourceDir)
  ) {
    const suffix = relative(
      input.primarySourceDir,
      input.absolutePath,
    ).replaceAll('\\', '/');
    return `skills/${input.skillId}/${suffix}`;
  }

  return relative(input.bundleRoot, input.absolutePath).replaceAll('\\', '/');
}

async function buildReleaseManifestSkill(
  entry: SkillCatalogEntry,
  input: {
    bundleRoot: string;
    releaseSupportPaths: string[];
    skillFile: string;
  },
): Promise<ReleaseManifestSkill> {
  const files = await loadSkillBundleMetadata(
    input.bundleRoot,
    await resolveReleaseBundleSources({
      bundleRoot: input.bundleRoot,
      releaseSupportPaths: input.releaseSupportPaths,
      skillFile: input.skillFile,
      sourceDir: entry.sourceDir,
    }),
    {
      primarySourceDir: entry.sourceDir,
      skillId: entry.skillId,
    },
  );

  return {
    skillId: entry.skillId,
    displayName: entry.displayName,
    description: entry.description,
    publishedVersion: await readPublishedVersion(entry.sourceDir),
    integrity: createBundleIntegrity(files),
    fileCount: files.length,
  };
}

async function resolveReleaseBundleSources(input: {
  bundleRoot: string;
  releaseSupportPaths: string[];
  skillFile: string;
  sourceDir: string;
}): Promise<string[]> {
  const sourcePaths = new Set<string>([input.sourceDir]);
  const pending = [input.sourceDir];

  for (const relativePath of input.releaseSupportPaths) {
    const absolutePath = await resolveAndValidateSupportPath({
      bundleRoot: input.bundleRoot,
      relativePath,
    });

    if (!sourcePaths.has(absolutePath)) {
      sourcePaths.add(absolutePath);
      pending.push(absolutePath);
    }
  }

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) {
      continue;
    }

    const candidateFiles = await listCandidateDependencyFiles({
      currentPath: current,
      skillFile: input.skillFile,
    });

    for (const filePath of candidateFiles) {
      const fileContent = await readFile(filePath, 'utf8');
      const inferredPaths = new Set<string>([
        ...extractMarkdownSupportPaths({
          bundleRoot: input.bundleRoot,
          fileContent,
          filePath,
          sourceDir: input.sourceDir,
        }),
        ...extractImportedSupportPaths({
          bundleRoot: input.bundleRoot,
          fileContent,
          filePath,
          sourceDir: input.sourceDir,
        }),
      ]);

      for (const relativePath of inferredPaths) {
        const absolutePath = await resolveAndValidateSupportPath({
          bundleRoot: input.bundleRoot,
          relativePath,
        });

        if (!sourcePaths.has(absolutePath)) {
          sourcePaths.add(absolutePath);
          pending.push(absolutePath);
        }
      }
    }
  }

  return [...sourcePaths];
}

async function listCandidateDependencyFiles(input: {
  currentPath: string;
  skillFile: string;
}) {
  const stats = await lstat(input.currentPath);

  if (stats.isFile()) {
    return shouldInspectDependencyFile(input.currentPath, input.skillFile)
      ? [input.currentPath]
      : [];
  }

  const files = await listFilesRecursively(input.currentPath);
  return files.filter((filePath) =>
    shouldInspectDependencyFile(filePath, input.skillFile),
  );
}

function shouldInspectDependencyFile(filePath: string, skillFile: string) {
  if (filePath === skillFile || basename(filePath) === 'SKILL.md') {
    return true;
  }

  return IMPORT_FILE_EXTENSIONS.has(extname(filePath));
}

async function resolveAndValidateSupportPath(input: {
  bundleRoot: string;
  relativePath: string;
}) {
  const absolutePath = resolve(input.bundleRoot, input.relativePath);
  const pathFromBundleRoot = relative(input.bundleRoot, absolutePath);

  if (
    pathFromBundleRoot.length === 0 ||
    pathFromBundleRoot.startsWith('..') ||
    pathFromBundleRoot === '.'
  ) {
    throw new Error(`Invalid release support path: ${input.relativePath}`);
  }

  if (!(await pathExists(absolutePath))) {
    throw new Error(`Missing release support path: ${input.relativePath}`);
  }

  return absolutePath;
}

function extractImportedSupportPaths(input: {
  bundleRoot: string;
  fileContent: string;
  filePath: string;
  sourceDir: string;
}) {
  const discovered = new Set<string>();

  for (const match of input.fileContent.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1]?.trim();
    if (!specifier || !specifier.startsWith('.')) {
      continue;
    }

    const resolvedPath = tryResolveDependencySpecifier({
      bundleRoot: input.bundleRoot,
      contextDir: dirname(input.filePath),
      specifier,
    });
    if (!resolvedPath) {
      continue;
    }

    const supportPath = buildImportedSupportPath({
      absolutePath: resolvedPath,
      bundleRoot: input.bundleRoot,
      sourceDir: input.sourceDir,
    });
    if (supportPath) {
      discovered.add(supportPath);
    }
  }

  return [...discovered];
}

function extractMarkdownSupportPaths(input: {
  bundleRoot: string;
  fileContent: string;
  filePath: string;
  sourceDir: string;
}) {
  const discovered = new Set<string>();

  for (const match of input.fileContent.matchAll(MARKDOWN_CODE_PATH_PATTERN)) {
    const candidate = match[1]?.trim();
    if (!candidate || candidate.includes('${')) {
      continue;
    }

    const resolvedPath = tryResolveMarkdownReference({
      bundleRoot: input.bundleRoot,
      candidate,
      contextDir: dirname(input.filePath),
    });
    if (!resolvedPath) {
      continue;
    }

    const supportPath = buildMarkdownSupportPath({
      absolutePath: resolvedPath,
      bundleRoot: input.bundleRoot,
      sourceDir: input.sourceDir,
    });
    if (supportPath) {
      discovered.add(supportPath);
    }
  }

  return [...discovered];
}

function tryResolveDependencySpecifier(input: {
  bundleRoot: string;
  contextDir: string;
  specifier: string;
}) {
  const candidates = [
    resolve(input.contextDir, input.specifier),
    resolve(input.contextDir, `${input.specifier}.mjs`),
    resolve(input.contextDir, `${input.specifier}.js`),
    resolve(input.contextDir, `${input.specifier}.ts`),
    resolve(input.contextDir, `${input.specifier}.tsx`),
    resolve(input.contextDir, input.specifier, 'index.mjs'),
    resolve(input.contextDir, input.specifier, 'index.js'),
    resolve(input.contextDir, input.specifier, 'index.ts'),
    resolve(input.contextDir, input.specifier, 'index.tsx'),
  ];

  for (const candidate of candidates) {
    const pathFromBundleRoot = relative(input.bundleRoot, candidate);
    if (
      pathFromBundleRoot.length === 0 ||
      pathFromBundleRoot.startsWith('..') ||
      pathFromBundleRoot === '.'
    ) {
      continue;
    }

    if (pathExistsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function tryResolveMarkdownReference(input: {
  bundleRoot: string;
  candidate: string;
  contextDir: string;
}) {
  const absolutePath = input.candidate.startsWith('skills/')
    ? resolve(input.bundleRoot, input.candidate)
    : input.candidate.startsWith('./') || input.candidate.startsWith('../')
      ? resolve(input.contextDir, input.candidate)
      : null;

  if (!absolutePath) {
    return null;
  }

  const pathFromBundleRoot = relative(input.bundleRoot, absolutePath);
  if (
    pathFromBundleRoot.length === 0 ||
    pathFromBundleRoot.startsWith('..') ||
    pathFromBundleRoot === '.'
  ) {
    return null;
  }

  return pathExistsSync(absolutePath) ? absolutePath : null;
}

function buildImportedSupportPath(input: {
  absolutePath: string;
  bundleRoot: string;
  sourceDir: string;
}) {
  if (isWithinPath(input.absolutePath, input.sourceDir)) {
    return null;
  }

  return collapseBundleSupportPath(input.bundleRoot, input.absolutePath);
}

function buildMarkdownSupportPath(input: {
  absolutePath: string;
  bundleRoot: string;
  sourceDir: string;
}) {
  if (isWithinPath(input.absolutePath, input.sourceDir)) {
    return null;
  }

  const relativePath = relative(
    input.bundleRoot,
    input.absolutePath,
  ).replaceAll('\\', '/');
  const segments = relativePath.split('/');

  if (segments[0] !== 'skills' || segments.length < 2) {
    return null;
  }

  const skillSegment = segments[1]!;

  if (
    skillSegment.startsWith('shared-') ||
    skillSegment.endsWith('-references')
  ) {
    return collapseBundleSupportPath(input.bundleRoot, input.absolutePath);
  }

  if (segments[2] === 'references' || segments[2] === 'scripts') {
    return `skills/${skillSegment}`;
  }

  return null;
}

function collapseBundleSupportPath(bundleRoot: string, absolutePath: string) {
  const relativePath = relative(bundleRoot, absolutePath).replaceAll('\\', '/');
  const segments = relativePath.split('/');

  if (segments[0] !== 'skills' || segments.length < 2) {
    return relativePath;
  }

  const skillSegment = segments[1]!;

  if (segments.length === 2) {
    return relativePath;
  }

  if (skillSegment.endsWith('.md')) {
    return relativePath;
  }

  return `skills/${skillSegment}`;
}

function isWithinPath(targetPath: string, basePath: string) {
  const relativePath = relative(basePath, targetPath);
  return (
    relativePath.length === 0 ||
    (!relativePath.startsWith('..') && !relativePath.startsWith(`..${sep}`))
  );
}

function pathExistsSync(pathname: string) {
  return existsSync(pathname);
}

export async function loadSkillCatalog(
  repoRoot: string,
): Promise<SkillCatalogEntry[]> {
  const { skillsRoot } = await requireSkillsRepoLayout(repoRoot);
  const catalog: SkillCatalogEntry[] = [];
  const sourceDirs = await listSkillSourceDirs(skillsRoot);

  for (const sourceDir of sourceDirs) {
    const skillFile = resolve(sourceDir, 'SKILL.md');

    try {
      const raw = await readFile(skillFile, 'utf8');
      const frontmatter = parseFrontmatter(raw);

      catalog.push({
        skillId: basename(sourceDir),
        sourceDir,
        skillFile,
        displayName:
          frontmatter.name?.trim() || parseHeading(raw) || basename(sourceDir),
        description: frontmatter.description?.trim() || null,
      });
    } catch {
      continue;
    }
  }

  return catalog.sort((left, right) =>
    left.skillId.localeCompare(right.skillId),
  );
}

async function listSkillSourceDirs(skillsRoot: string): Promise<string[]> {
  const discovered = new Set<string>();
  const pending = [skillsRoot];

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const sourceDir = resolve(current, entry.name);
      const skillFile = resolve(sourceDir, 'SKILL.md');

      if (await pathExists(skillFile)) {
        discovered.add(sourceDir);
        continue;
      }

      pending.push(sourceDir);
    }
  }

  return [...discovered].sort((left, right) => left.localeCompare(right));
}

export async function loadReleaseManifest(
  repoRoot: string,
): Promise<ReleaseManifest> {
  const { bundleRoot } = await requireSkillsRepoLayout(repoRoot);
  const [catalog, releaseReadySkills] = await Promise.all([
    loadSkillCatalog(repoRoot),
    loadReleaseReadySkillIdsFromRegistry(repoRoot),
  ]);
  const releasedCatalog = catalog.filter((entry) =>
    releaseReadySkills.has(entry.skillId),
  );
  const skills = await Promise.all(
    releasedCatalog.map((entry) =>
      buildReleaseManifestSkill(entry, {
        bundleRoot,
        releaseSupportPaths:
          releaseReadySkills.get(entry.skillId)?.releaseSupportPaths ?? [],
        skillFile: entry.skillFile,
      }),
    ),
  );

  return {
    formatVersion: 1,
    messages: [],
    skillCount: skills.length,
    skills,
  };
}

export async function loadReleaseSkillBundle(input: {
  repoRoot: string;
  skillId: string;
}): Promise<ReleaseSkillBundle> {
  const { bundleRoot } = await requireSkillsRepoLayout(input.repoRoot);
  const [catalog, releaseReadySkills] = await Promise.all([
    loadSkillCatalog(input.repoRoot),
    loadReleaseReadySkillIdsFromRegistry(input.repoRoot),
  ]);
  if (!releaseReadySkills.has(input.skillId)) {
    throw new Error(`Unknown released skill: ${input.skillId}`);
  }
  const entry = catalog.find((item) => item.skillId === input.skillId);

  if (!entry) {
    throw new Error(`Unknown released skill: ${input.skillId}`);
  }

  const [metadata, publishedVersion] = await Promise.all([
    loadSkillBundleMetadata(
      bundleRoot,
      await resolveReleaseBundleSources({
        bundleRoot,
        releaseSupportPaths:
          releaseReadySkills.get(input.skillId)?.releaseSupportPaths ?? [],
        skillFile: entry.skillFile,
        sourceDir: entry.sourceDir,
      }),
      {
        primarySourceDir: entry.sourceDir,
        skillId: entry.skillId,
      },
    ),
    readPublishedVersion(entry.sourceDir),
  ]);

  const files = await Promise.all(
    metadata.map(async (file) => {
      const buffer = await readFile(file.absolutePath);

      return {
        path: file.relativePath,
        size: file.size,
        sha256: file.sha256,
        contentBase64: buffer.toString('base64'),
      };
    }),
  );

  return {
    skillId: entry.skillId,
    displayName: entry.displayName,
    description: entry.description,
    publishedVersion,
    integrity: createBundleIntegrity(metadata),
    files,
  };
}
