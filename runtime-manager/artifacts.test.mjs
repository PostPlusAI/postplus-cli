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
  const repaired = await prepareArtifact(root, artifact, destination, noNetwork, archive, { repair: true });
  assert.equal(repaired.repaired, true);
  assert.notEqual(repaired.directory, destination);
  await verifyArtifactDirectory(repaired.directory, artifact.sha256);
  assert.equal(await readFile(join(repaired.directory, 'file'), 'utf8'), 'approved');
  assert.equal(await readFile(join(destination, 'file'), 'utf8'), 'modified', 'explicit repair preserves the old generation');
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

test('preparation reports filesystem and extraction failures without changing an old generation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postplus-prepare-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = join(root, 'old-generation');
  await mkdir(old);
  await writeFile(join(old, 'keep'), 'running old program');
  const bytes = Buffer.from('not an archive');
  const artifact = { url: 'https://example.test/node.tar.gz', directory: 'node', sha256: createHash('sha256').update(bytes).digest('hex') };
  await assert.rejects(prepareArtifact(root, artifact, join(root, 'new-generation'), async () => new Response(bytes), undefined, { component: 'node', version: '24.21.0' }), error => {
    assert.equal(error.component, 'node');
    assert.equal(error.version, '24.21.0');
    assert.equal(error.stage, 'artifact-extract');
    assert.equal(error.timeoutMs, 120000);
    assert.ok(error.cause);
    return true;
  });
  const file = join(root, 'not-a-directory');
  await writeFile(file, 'file');
  await assert.rejects(prepareArtifact(file, artifact, join(file, 'new'), async () => assert.fail('must not fetch'), undefined, { component: 'cli', version: '0.2.21' }), error => {
    assert.equal(error.component, 'cli');
    assert.equal(error.stage, 'artifact-prepare');
    assert.ok(['ENOTDIR', 'EEXIST'].includes(error.code));
    return true;
  });
  assert.equal(await readFile(join(old, 'keep'), 'utf8'), 'running old program');
});
