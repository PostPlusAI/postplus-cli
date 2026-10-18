import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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

test('request failures preserve original codes, context and exact transport cause without guessing TLS', async t => {
  for (const component of ['release-metadata', 'node', 'cli']) {
    for (const [name, code] of [['TimeoutError', 'ETIMEDOUT'], ['Error', 'ENOTFOUND'], ['Error', 'CERT_HAS_EXPIRED'], ['TypeError', 'UND_ERR_SOCKET']]) {
      const original = Object.assign(new Error('request failed'), { name, code });
      const fetchFn = async () => { throw original; };
      await assert.rejects(component === 'release-metadata' ? fetchRelease(fetchFn) :
        downloadArtifact(artifact, await destination(t), fetchFn, { component, version: '24.21.0' }), error => {
        assert.equal(error.component, component);
        assert.equal(error.code, code);
        assert.equal(error.cause, original);
        assert.equal(error.stage, component === 'release-metadata' ? 'release-request' : 'artifact-request');
        assert.equal(error.operation, component === 'release-metadata' ? 'fetch-release' : 'download-artifact');
        assert.equal(error.platform, `${process.platform}-${process.arch}`);
        assert.equal(error.originalUrl, component === 'release-metadata' ? 'https://postplus.io/postplus-runtime.json' : artifact.url);
        assert.equal(error.failureUrl, error.originalUrl);
        assert.ok(error.elapsedMs >= 0);
        assert.equal(error.timeoutMs, component === 'release-metadata' ? 30000 : 300000);
        assert.doesNotMatch(error.action, /certificate|TLS|CA_CERTS/);
        return true;
      });
    }
  }
});

test('download diagnostics identify the failed CDN URL, HTTP status and body failures', async t => {
  const path = await destination(t);
  const cdn = 'https://cdn.example.test/file?signature=private';
  let calls = 0;
  await assert.rejects(downloadArtifact(artifact, path, async () => ++calls === 1
    ? new Response(null, { status: 302, headers: { location: cdn } })
    : new Response('unavailable', { status: 503 }), { component: 'cli', version: '0.2.21' }), error => {
    assert.equal(error.httpStatus, 503);
    assert.equal(error.originalUrl, artifact.url);
    assert.equal(error.failureUrl, cdn);
    assert.equal(error.version, '0.2.21');
    assert.equal(error.stage, 'artifact-request');
    return true;
  });
  const broken = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(Object.assign(new Error('body terminated'), { code: 'UND_ERR_SOCKET' })); },
  }));
  for (const request of [() => fetchRelease(async () => broken()), () => downloadArtifact(artifact, path, async () => broken())]) {
    await assert.rejects(request(), error => {
      assert.equal(error.code, 'UND_ERR_SOCKET');
      assert.match(error.stage, /-body$/);
      assert.equal(error.httpStatus, 200);
      return true;
    });
  }
  await assert.rejects(stat(path), { code: 'ENOENT' });
  await assert.rejects(downloadArtifact(artifact, path, async () => new Response('changed')), error => {
    assert.equal(error.stage, 'artifact-checksum'); return true;
  });
  await assert.rejects(downloadArtifact(artifact, path, async () => new Response(null, { status: 302, headers: { location: 'http://bad.example.test/file' } })), error => {
    assert.equal(error.stage, 'artifact-redirect');
    assert.equal(error.httpStatus, 302);
    return true;
  });
});


test('artifact write permission failures identify the write stage and preserve EACCES', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async t => {
  const path = await destination(t);
  const directory = join(path, '..');
  await chmod(directory, 0o500);
  try {
    await assert.rejects(downloadArtifact(artifact, path, async () => new Response(bytes), { component: 'cli', version: '0.2.21' }), error => {
      assert.equal(error.code, 'EACCES');
      assert.equal(error.component, 'cli');
      assert.equal(error.stage, 'artifact-write');
      assert.equal(error.cause.code, 'EACCES');
      return true;
    });
  } finally { await chmod(directory, 0o700); }
});
