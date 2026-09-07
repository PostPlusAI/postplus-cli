// Real process / filesystem regression: both contenders observe the same dead
// owner, then the second is held until the first has published a new live lock.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const [role, moduleUrl, staleOwnerFile] = process.argv.slice(2);
const configDir = process.env.POSTPLUS_CONFIG_DIR;
const lockPath = join(configDir, 'update.lock');
const staleOwnerPath = join(lockPath, staleOwnerFile);
const activePath = join(configDir, 'active-mutation');
const originalReadFile = fs.readFile;
const originalUnlink = fs.unlink;
const originalRm = fs.rm;
let observed = false;
let delayedCleanup = false;

async function waitFor(filename) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await fs.access(join(configDir, filename));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

fs.readFile = async (path, ...args) => {
  const contents = await originalReadFile(path, ...args);
  if (String(path) === staleOwnerPath && !observed) {
    observed = true;
    await fs.writeFile(join(configDir, `${role}-observed`), 'ready');
    await waitFor(`${role === 'first' ? 'second' : 'first'}-observed`);
    console.log(`${role}:observed-dead-owner`);
  }
  return contents;
};

async function delayStaleCleanup(operation) {
  delayedCleanup = true;
  await waitFor('first-holding');
  console.log('second:stale-cleanup-after-new-owner');
  try {
    return await operation();
  } finally {
    await fs.writeFile(join(configDir, 'second-cleanup-attempted'), 'done');
  }
}

fs.unlink = async (path, ...args) => {
  if (role === 'second' && String(path) === staleOwnerPath && !delayedCleanup) {
    return delayStaleCleanup(() => originalUnlink(path, ...args));
  }
  return originalUnlink(path, ...args);
};

// Also schedule the vulnerable pre-fix recursive removal, so this exact test
// proves red against the old implementation rather than just testing a helper.
fs.rm = async (path, ...args) => {
  if (role === 'second' && String(path) === lockPath && !delayedCleanup) {
    return delayStaleCleanup(() => originalRm(path, ...args));
  }
  return originalRm(path, ...args);
};
syncBuiltinESMExports();

const { withPostPlusUpdateLock } = await import(moduleUrl);
await withPostPlusUpdateLock(async () => {
  await fs.mkdir(activePath); // EEXIST proves two mutations overlapped.
  console.log(`${role}:mutation-start`);
  try {
    if (role === 'first') {
      const ownFiles = await fs.readdir(lockPath);
      await fs.writeFile(join(configDir, 'first-holding'), 'ready');
      await waitFor('second-cleanup-attempted');
      assert.deepEqual(await fs.readdir(lockPath), ownFiles);
      console.log('first:new-owner-preserved');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    console.log(`${role}:mutation-end`);
    await fs.rmdir(activePath);
  }
}, { pollMs: 5, timeoutMs: 6_000 });
console.log(`${role}:exit=0`);
