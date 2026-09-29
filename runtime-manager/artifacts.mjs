import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { downloadArtifact, extractArtifact } from './distribution.mjs';
const RECEIPT = '.postplus-artifact.json';

export async function hashDirectory(root) {
  const base = await realpath(root);
  const hash = createHash('sha256');
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!prefix && entry.name === RECEIPT) continue;
      const name = prefix + entry.name;
      const path = join(directory, entry.name);
      hash.update(JSON.stringify([name, entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'file']) + '\n');
      if (entry.isDirectory()) await walk(path, `${name}/`);
      else if (entry.isSymbolicLink()) {
        const target = await realpath(path);
        const inside = relative(base, target);
        if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Artifact symlink leaves its managed directory.');
        hash.update(await readlink(path));
      } else if (entry.isFile()) {
        // Hash each file separately so concatenation cannot hide entry boundaries.
        const fileHash = createHash('sha256');
        for await (const bytes of createReadStream(path)) fileHash.update(bytes);
        hash.update(fileHash.digest('hex'));
      } else throw new Error('Artifact contains an unsupported filesystem entry.');
      hash.update('\n');
    }
  }
  await walk(base);
  return hash.digest('hex');
}

export async function verifyArtifactDirectory(directory, sha256) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Managed artifact directory is not a regular directory.');
  const receipt = JSON.parse(await readFile(join(directory, RECEIPT), 'utf8'));
  if (receipt.schemaVersion !== 1 || receipt.sha256 !== sha256 || receipt.contentHash !== await hashDirectory(directory)) {
    throw new Error('Managed artifact integrity verification failed. Run the official installer to repair it.');
  }
}

export async function prepareArtifact(root, artifact, destination, fetchFn, archiveFile) {
  try {
    await lstat(destination);
    await verifyArtifactDirectory(destination, artifact.sha256);
    return { directory: destination, reused: true };
  } catch (error) {
    // An existing but corrupt directory is a failure, not permission to overwrite
    // files that another running CLI might still use.
    if (error.code !== 'ENOENT') throw error;
    try { await lstat(destination); throw new Error('Managed artifact is incomplete. No running installation was changed.'); }
    catch (nested) { if (nested.code !== 'ENOENT') throw nested; }
  }
  await mkdir(root, { recursive: true });
  const temp = await mkdtemp(join(root, '.prepare-'));
  try {
    const archive = archiveFile ?? join(temp, new URL(artifact.url).pathname.endsWith('.zip') ? 'artifact.zip' : 'artifact.tar.gz');
    if (archiveFile) {
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(archiveFile)) hash.update(bytes);
      if (hash.digest('hex') !== artifact.sha256) throw new Error('Local PostPlus archive does not match the approved release.');
    } else await downloadArtifact(artifact, archive, fetchFn);
    const source = await extractArtifact(archive, artifact, join(temp, 'extracted'));
    const staged = join(temp, 'prepared');
    await cp(source, staged, { recursive: true, dereference: false, verbatimSymlinks: true });
    await rm(join(staged, RECEIPT), { force: true });
    const contentHash = await hashDirectory(staged);
    await writeFile(join(staged, RECEIPT), JSON.stringify({ schemaVersion: 1, sha256: artifact.sha256, contentHash }) + '\n', { mode: 0o600 });
    await mkdir(join(destination, '..'), { recursive: true });
    await rename(staged, destination);
    return { directory: destination, reused: false };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
