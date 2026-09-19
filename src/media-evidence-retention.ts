// Only disposable video evidence is collected. Recovery records remain durable.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat, realpath, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { getPostPlusConfigDir } from './local-state.js';

export const MEDIA_EVIDENCE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
type RecordState = { schemaVersion: 1; lastUsedAt: number; terminalAt: number | null; files?: Record<string, string>; protected?: true };
const validKey = (key: string) => /^[a-f0-9]{64}$/.test(key);
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function stateAt(directory: string): Promise<RecordState | null> {
  try {
    const value = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
    return value?.schemaVersion === 1 && Number.isFinite(value.lastUsedAt) && value.lastUsedAt >= 0 &&
      (value.terminalAt === null || (Number.isFinite(value.terminalAt) && value.terminalAt >= 0)) ? value : null;
  } catch { return null; } // Unknown or damaged metadata never authorizes deletion.
}
async function save(directory: string, state: RecordState) {
  const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, path.join(directory, 'state.json'));
  } finally { await rm(temporary, { force: true }); }
}

// Short metadata-only mutex. Its owner never launches children. Generation
// tokens prevent a stale observer from removing a replacement owner's lock.
async function gate(directory: string, action: () => Promise<void>, skipIfBusy = false): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = `owner-${randomUUID()}.json`;
  const candidate = path.join(directory, `.gate-${token}`);
  const lock = path.join(directory, 'gate');
  await mkdir(candidate);
  await writeFile(path.join(candidate, token), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const deadline = Date.now() + 10_000;
  try {
    for (;;) {
      try {
        // An empty/corrupt gate is still unknown ownership, not a free slot.
        if (await lstat(lock).then(() => true, (error) => { if (isMissing(error)) return false; throw error; })) {
          throw Object.assign(new Error('Media evidence gate is occupied.'), { code: 'EEXIST' });
        }
        await rename(candidate, lock); break;
      }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        if (skipIfBusy) return; // Opportunistic collection never waits on unrelated work.
        const owners = await readdir(lock).catch(() => []);
        if (owners.length === 1 && /^owner-[a-f0-9-]+\.json$/.test(owners[0]!)) {
          try {
            const owner = JSON.parse(await readFile(path.join(lock, owners[0]!), 'utf8'));
            if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
              try { process.kill(owner.pid, 0); }
              catch (cause) {
                if ((cause as NodeJS.ErrnoException).code === 'ESRCH') {
                  await rm(path.join(lock, owners[0]!), { force: true });
                  await rmdir(lock).catch(() => {});
                }
              }
            }
          } catch { /* Unknown ownership is not permission to reclaim. */ }
        }
        if (Date.now() >= deadline) throw new Error('Media evidence metadata is busy; retry the same operation.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try { return await action(); }
    finally { await rm(path.join(lock, token), { force: true }); await rmdir(lock); }
  } finally { await rm(candidate, { recursive: true, force: true }); }
}

async function safeDirectory(directory: string): Promise<boolean> {
  try {
    return (await lstat(directory)).isDirectory() && path.resolve(await realpath(directory)) === path.resolve(directory);
  } catch (error) { if (isMissing(error)) return false; throw error; }
}

async function cacheSnapshot(directory: string): Promise<Record<string, string> | null> {
  if (!await safeDirectory(directory)) return null;
  const result: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) {
    if (!['video.mp4', 'audio.m4a', 'source.mp4'].includes(name)) return null;
    const info = await lstat(path.join(directory, name));
    if (!info.isFile() || info.nlink !== 1) return null;
    result[name] = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  }
  return result;
}

export async function collectExpiredMediaEvidence(root = getPostPlusConfigDir(), now = Date.now()): Promise<number> {
  root = await realpath(root).catch((error) => { if (isMissing(error)) return path.resolve(root); throw error; });
  const evidence = path.join(root, 'media-evidence');
  const records = path.join(root, 'media-evidence-retention');
  if (!await safeDirectory(evidence) || !await safeDirectory(records)) return 0;
  let removed = 0;
  for (const key of await readdir(records)) {
    if (!validKey(key)) continue;
    const recordDir = path.join(records, key);
    const directory = path.join(evidence, key);
    if (!await safeDirectory(recordDir)) continue;
    await gate(recordDir, async () => {
      const state = await stateAt(recordDir);
      if (!state || state.protected || !state.files || state.terminalAt === null || now - Math.max(state.terminalAt, state.lastUsedAt) < MEDIA_EVIDENCE_RETENTION_MS) return;
      if ((await readdir(recordDir)).some((name) => name.startsWith('active-'))) return;
      if (!await safeDirectory(directory)) return;
      const files = await cacheSnapshot(directory);
      if (!files || JSON.stringify(files) !== JSON.stringify(state.files)) return;
      await rm(directory, { recursive: true });
      removed += 1;
    }, true);
  }
  return removed;
}

export async function withMediaEvidence<T>(
  checkpointPath: string | null,
  action: (markTerminal: () => void) => Promise<T>,
  options: { root?: string; now?: () => number; outputPath?: string | null } = {},
): Promise<T> {
  if (!checkpointPath) return action(() => {}); // Hosted-library callers own their storage.
  const root = options.root ?? getPostPlusConfigDir();
  const key = path.basename(checkpointPath, '.json');
  if (!validKey(key)) return action(() => {}); // Arbitrary external checkpoints are never managed caches.
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const checkpointParent = await realpath(path.dirname(checkpointPath)).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (checkpointParent !== path.join(canonicalRoot, 'media-runs')) return action(() => {});
  const checkpointFile = await lstat(checkpointPath).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!checkpointFile?.isFile()) return action(() => {});

  const directory = path.join(canonicalRoot, 'media-evidence-retention', key);
  const now = options.now ?? Date.now;
  const token = `active-${randomUUID()}.json`;
  let terminal = false;
  const recordsRoot = path.dirname(directory);
  await mkdir(recordsRoot, { recursive: true, mode: 0o700 });
  if (!await safeDirectory(recordsRoot)) throw new Error('Media evidence retention storage must be a real managed directory.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!await safeDirectory(directory)) throw new Error('Media evidence retention record must be a real managed directory.');
  await gate(directory, async () => {
    const prior = await stateAt(directory);
    // Only a newly created cache can acquire deletion authority. Existing
    // legacy or damaged entries remain unclassified and are retained.
    const cacheExists = await lstat(path.join(canonicalRoot, 'media-evidence', key)).then(() => true, (error) => { if (isMissing(error)) return false; throw error; });
    const changedOutsideOperation = prior?.files && cacheExists && JSON.stringify(prior.files) !== JSON.stringify(await cacheSnapshot(path.join(canonicalRoot, 'media-evidence', key)));
    if (prior || !cacheExists) await save(directory, { schemaVersion: 1, lastUsedAt: now(), terminalAt: null,
      ...(prior?.protected || changedOutsideOperation || (options.outputPath && path.resolve(options.outputPath).startsWith(path.join(canonicalRoot, 'media-evidence', key) + path.sep)) ? { protected: true as const } : {}),
    });
    await writeFile(path.join(directory, token), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  });
  try {
    await collectExpiredMediaEvidence(canonicalRoot, now());
    return await action(() => { terminal = true; });
  }
  finally {
    await gate(directory, async () => {
      const state = await stateAt(directory);
      if (state) {
        const files = terminal ? await cacheSnapshot(path.join(canonicalRoot, 'media-evidence', key)) : null;
        await save(directory, { ...state, lastUsedAt: now(), terminalAt: terminal ? now() : null,
          ...(files ? { files } : {}),
        });
      }
      await rm(path.join(directory, token), { force: true });
    });
  }
}
