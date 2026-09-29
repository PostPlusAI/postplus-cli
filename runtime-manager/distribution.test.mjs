import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { downloadArtifact, fetchRelease, selectNodeArtifact, validateRelease } from './distribution.mjs';
const bytes = Buffer.from('verified release artifact');
const artifact = { url: 'https://releases.example.test/cli.tar.gz', directory: 'postplus-cli', sha256: createHash('sha256').update(bytes).digest('hex') };
const release = { schemaVersion: 1, releaseId: '2026-09-29.1', cliVersion: '0.2.13', skillsReleaseId: 'skills-test', cli: artifact, node: { version: '24.21.0', artifacts: { 'darwin-arm64': artifact } } };
async function destination(t) {
  const root = await mkdtemp(join(tmpdir(), 'postplus-download-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'artifact.tgz');
}
test('approved digest is required and an incomplete or corrupt download is removed', async t => {
  const path = await destination(t);
  await downloadArtifact(artifact, path, async () => new Response(bytes));
  assert.deepEqual(await readFile(path), bytes);
  await assert.rejects(downloadArtifact(artifact, path, async () => new Response(bytes)), { code: 'EEXIST' });
  assert.deepEqual(await readFile(path), bytes, 'existing artifact must not be removed by a failed exclusive write');
  await rm(path);
  await assert.rejects(downloadArtifact(artifact, path, async () => new Response('changed')), /checksum/);
  await assert.rejects(stat(path), { code: 'ENOENT' });
  await assert.rejects(downloadArtifact(artifact, path, async () => new Response(null, { status: 503 })), /503/);
  await assert.rejects(stat(path), { code: 'ENOENT' });
});
test('artifact redirects support HTTPS CDNs but never downgrade or loop', async t => {
  const path = await destination(t);
  const calls = [];
  await downloadArtifact(artifact, path, async url => {
    calls.push(url);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.test/file' } }) : new Response(bytes);
  });
  assert.deepEqual(calls, [artifact.url, 'https://cdn.example.test/file']);
  await rm(path);
  await assert.rejects(downloadArtifact(artifact, path, async () => new Response(null, { status: 302, headers: { location: 'http://cdn.example.test/file' } })), /HTTPS/);
  await assert.rejects(downloadArtifact(artifact, path, async () => new Response(null, { status: 302, headers: { location: artifact.url } })), /redirect limit/);
});
test('release metadata rejects unsupported platforms, broken identity and executable paths', async () => {
  assert.equal(selectNodeArtifact(release, 'darwin', 'arm64'), artifact);
  assert.throws(() => selectNodeArtifact(release, 'linux', 'x64'), /does not yet provide/);
  assert.throws(() => validateRelease({ ...release, cliVersion: '../escape' }), /Invalid/);
  assert.throws(() => validateRelease({ ...release, cli: { ...artifact, directory: '..' } }), /Invalid/);
  await assert.rejects(fetchRelease(async () => new Response('{}')), /Invalid/);
  assert.deepEqual(await fetchRelease(async () => Response.json(release)), release);
});

test('oversized metadata cancels the response before consuming the remaining body', async () => {
  let cancelled = false;
  let reads = 0;
  const body = new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(128 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(fetchRelease(async () => new Response(body)), /too large/);
  assert.equal(cancelled, true);
  assert.ok(reads <= 2);
});
