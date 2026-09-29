import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashDirectory, prepareArtifact, verifyArtifactDirectory } from './artifacts.mjs';
import { TAR_EXECUTABLE } from './distribution.mjs';
const exec = promisify(execFile);

test('verified local archive is prepared once; a changed installed file is never silently reused', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postplus-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(join(source, 'package'), { recursive: true });
  await writeFile(join(source, 'package/file'), 'approved');
  const archive = join(root, 'archive.tar.gz');
  await exec(TAR_EXECUTABLE, ['-czf', archive, '-C', source, 'package']);
  const artifact = { url: 'https://example.test/archive.tar.gz', directory: 'package', sha256: createHash('sha256').update(await readFile(archive)).digest('hex') };
  const destination = join(root, 'versions/fixture');
  const noNetwork = async () => assert.fail('a supplied archive must not fetch');
  assert.equal((await prepareArtifact(root, artifact, destination, noNetwork, archive)).reused, false);
  await verifyArtifactDirectory(destination, artifact.sha256);
  assert.equal((await prepareArtifact(root, artifact, destination, noNetwork)).reused, true);
  await writeFile(join(destination, 'file'), 'modified');
  await assert.rejects(prepareArtifact(root, artifact, destination, noNetwork), /integrity/);
  assert.equal(await readFile(join(destination, 'file'), 'utf8'), 'modified');
  const wrong = { ...artifact, sha256: '0'.repeat(64) };
  await assert.rejects(prepareArtifact(root, wrong, join(root, 'versions/wrong'), noNetwork, archive), /does not match/);
});

test('artifact integrity includes links and rejects targets outside the installation', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'postplus-artifact-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'file'), 'content');
  await symlink('file', join(root, 'inside'));
  const before = await hashDirectory(root);
  await rm(join(root, 'inside'));
  assert.notEqual(await hashDirectory(root), before);
  await symlink(process.execPath, join(root, 'outside'));
  await assert.rejects(hashDirectory(root), /leaves its managed directory/);
});
