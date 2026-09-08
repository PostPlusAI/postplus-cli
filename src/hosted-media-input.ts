import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import type { ManifestField } from './hosted-manifest-index.js';
import {
  getPostPlusConfigDir,
  readLocalConfig,
  resolveApiBaseUrlState,
} from './local-state.js';

const MEDIA_REFERENCE_PREFIXES = [
  'https://',
  'postplus-media://',
  'data:',
] as const;
const MEDIA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MEDIA_CACHE_FILE_MODE = 0o600;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

type MediaCacheEntry = {
  expiresAt: number;
  mediaReference: string;
};

type MediaCacheFile = {
  entries: Record<string, MediaCacheEntry>;
  schemaVersion: 'postplus-media-staging-cache/v1';
};

export type LocalMediaFile = {
  absolutePath: string;
  contentSha256: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
};

export type StageLocalMediaFile = (input: {
  field: ManifestField;
  file: LocalMediaFile;
  operationId: string;
}) => Promise<string>;

/**
 * Resolve only Manifest-declared media fields. Remote/durable references pass
 * through byte-for-byte; local regular files are durably staged before submit.
 * No ordinary string or prompt field is inspected, so path-like creative text
 * can never trigger a filesystem read or upload.
 */
export async function resolveManifestMediaInputs(input: {
  endpointKey: string;
  fields: readonly ManifestField[];
  request: Record<string, unknown>;
  stage: StageLocalMediaFile | null;
}): Promise<Record<string, unknown>> {
  const resolved = { ...input.request };
  const inCommand = new Map<string, Promise<string>>();
  const cacheScope = input.stage ? await resolveMediaCacheScope() : null;
  const cache = cacheScope ? await readMediaCache() : emptyMediaCache();

  for (const field of input.fields) {
    if (
      field.class === 'runner-managed' ||
      field.type !== 'media-url' ||
      !Object.hasOwn(resolved, field.name)
    ) {
      continue;
    }
    if (!field.mediaKind) {
      throw new Error(
        `${input.endpointKey} ${field.name} is missing Manifest mediaKind metadata.`,
      );
    }

    const raw = resolved[field.name];
    const values = Array.isArray(raw) ? raw : [raw];
    const next: unknown[] = [];

    for (const entry of values) {
      if (typeof entry !== 'string' || !entry.trim()) {
        next.push(entry);
        continue;
      }
      const value = entry.trim();
      if (hasReferenceScheme(value)) {
        next.push(entry);
        continue;
      }

      const explicitLocal = value.startsWith('@');
      const candidate = explicitLocal ? value.slice(1) : value;
      const local = await inspectLocalMediaFile(candidate, {
        explicitLocal,
        field,
      });
      if (!local) {
        next.push(entry);
        continue;
      }
      if (!input.stage || !cacheScope) {
        throw new Error(
          `${input.endpointKey} ${field.name} received local file ${local.absolutePath}, but this in-process host cannot read or upload caller-local files. Use a PostPlus media reference or HTTPS URL.`,
        );
      }

      const cacheKey = hashCacheKey({
        contentSha256: local.contentSha256,
        mediaKind: field.mediaKind,
        mimeType: local.mimeType,
        scope: cacheScope,
      });
      const cached = cache.entries[cacheKey];
      if (
        cached &&
        cached.expiresAt > Date.now() &&
        cached.mediaReference.startsWith('postplus-media://')
      ) {
        next.push(cached.mediaReference);
        continue;
      }

      let staged = inCommand.get(cacheKey);
      if (!staged) {
        staged = input.stage({
          field,
          file: local,
          operationId: `postplus-cli:media-file:stage:${cacheKey}`,
        });
        inCommand.set(cacheKey, staged);
      }
      const mediaReference = await staged;
      if (!mediaReference.startsWith('postplus-media://')) {
        throw new Error(
          `Hosted media staging for ${field.name} did not return a persistent PostPlus media reference.`,
        );
      }
      cache.entries[cacheKey] = {
        expiresAt: Date.now() + MEDIA_CACHE_TTL_MS,
        mediaReference,
      };
      // Persist each completed staging edge immediately. If a later item in the
      // same multi-media request fails, a retry reuses every successful object
      // and resumes at the first missing input without any provider submit.
      await writeMediaCache(cache);
      next.push(mediaReference);
    }

    resolved[field.name] = Array.isArray(raw) ? next : next[0];
  }

  return resolved;
}

export function inferMediaMimeType(filePath: string): string | null {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
}

async function inspectLocalMediaFile(
  candidate: string,
  input: { explicitLocal: boolean; field: ManifestField },
): Promise<LocalMediaFile | null> {
  if (!candidate.trim()) {
    throw new Error(
      `${input.field.flag ?? input.field.name} local path is empty.`,
    );
  }
  const requestedPath = path.resolve(candidate);
  let absolutePath: string;
  let fileStat;
  try {
    absolutePath = await realpath(requestedPath);
    fileStat = await stat(absolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!input.explicitLocal && (code === 'ENOENT' || code === 'ENOTDIR')) {
      return null;
    }
    throw new Error(
      `Local media file is not readable: ${requestedPath}${code ? ` (${code})` : ''}.`,
      { cause: error },
    );
  }
  if (!fileStat.isFile()) {
    throw new Error(
      `Local media input is not a regular file: ${absolutePath}.`,
    );
  }

  // Opening once here validates read permission before a hosted upload URL is
  // minted. The stream used for the PUT is opened only after admission succeeds.
  const handle = await open(absolutePath, 'r');
  await handle.close();

  const mimeType = inferMediaMimeType(absolutePath);
  if (!mimeType) {
    throw new Error(
      `Cannot infer a supported media type for local file ${absolutePath}. Use a supported image, video, or audio extension.`,
    );
  }
  if (!mimeType.startsWith(`${input.field.mediaKind}/`)) {
    throw new Error(
      `${input.field.flag ?? input.field.name} expects ${input.field.mediaKind}, but ${absolutePath} resolves to ${mimeType}.`,
    );
  }

  return {
    absolutePath,
    contentSha256: await sha256File(absolutePath),
    mimeType,
    name: path.basename(absolutePath),
    sizeBytes: fileStat.size,
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function hasReferenceScheme(value: string): boolean {
  return MEDIA_REFERENCE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

async function resolveMediaCacheScope(): Promise<string> {
  const [api, config] = await Promise.all([
    resolveApiBaseUrlState(),
    readLocalConfig(),
  ]);
  return `${api.value ?? 'missing'}\n${config?.accountId ?? 'unknown-account'}`;
}

function hashCacheKey(input: {
  contentSha256: string;
  mediaKind: string;
  mimeType: string;
  scope: string;
}): string {
  return createHash('sha256')
    .update(
      `${input.scope}\n${input.mediaKind}\n${input.mimeType}\n${input.contentSha256}`,
    )
    .digest('hex');
}

function mediaCachePath(): string {
  return path.join(getPostPlusConfigDir(), 'media-staging-cache.json');
}

function emptyMediaCache(): MediaCacheFile {
  return { entries: {}, schemaVersion: 'postplus-media-staging-cache/v1' };
}

async function readMediaCache(): Promise<MediaCacheFile> {
  try {
    const parsed = JSON.parse(
      await readFile(mediaCachePath(), 'utf8'),
    ) as Partial<MediaCacheFile>;
    if (
      parsed.schemaVersion !== 'postplus-media-staging-cache/v1' ||
      !parsed.entries ||
      typeof parsed.entries !== 'object'
    ) {
      return emptyMediaCache();
    }
    const entries: Record<string, MediaCacheEntry> = {};
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (
        value &&
        typeof value.expiresAt === 'number' &&
        typeof value.mediaReference === 'string' &&
        value.expiresAt > Date.now()
      ) {
        entries[key] = value;
      }
    }
    return { entries, schemaVersion: 'postplus-media-staging-cache/v1' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyMediaCache();
    }
    throw new Error('PostPlus media staging cache is unreadable.', {
      cause: error,
    });
  }
}

async function writeMediaCache(cache: MediaCacheFile): Promise<void> {
  const target = mediaCachePath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: 'utf8',
      mode: MEDIA_CACHE_FILE_MODE,
    });
    await rename(temporary, target);
    await chmod(target, MEDIA_CACHE_FILE_MODE);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new Error('Unable to persist the PostPlus media staging cache.', {
      cause: error,
    });
  }
}
