import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fetchManagedRelease, resolveManagedInvocation } from './managed-runtime.js';

const release = {
  schemaVersion: 1, releaseId: 'fixture', cliVersion: '0.2.13', skillsReleaseId: 'skills-fixture',
  cli: { url: 'https://example.invalid/cli.tar.gz', sha256: 'a'.repeat(64), directory: 'postplus-cli' },
  node: { version: '24.21.0', artifacts: {
    'linux-x64': { url: 'https://example.invalid/node.tar.gz', sha256: 'b'.repeat(64), directory: 'node' },
  } },
};

test('managed update metadata uses the official release without invoking npm', async () => {
  const value = await fetchManagedRelease(async input => {
    assert.equal(String(input), 'https://postplus.io/postplus-runtime.json');
    return Response.json(release);
  });
  assert.equal(value.cliVersion, release.cliVersion);
  assert.equal(value.skillsReleaseId, release.skillsReleaseId);
});

test('retry resolves the newly active private Node and CLI, never the original process or PATH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'postplus-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function activate(version: string, node: string) {
    const paths = { node: `runtimes/node-v${node}-fixture/bin/node`, cli: `versions/${version}/fixture/build/index.js`, manager: `versions/${version}/fixture/runtime-manager/index.mjs` };
    for (const path of Object.values(paths)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), 'fixture');
    }
    await writeFile(join(root, 'active'), ['postplus-installation-v1', version, node, paths.node, paths.cli, paths.manager, ''].join('\n'));
    return paths;
  }
  await activate('0.2.12', '24.7.0');
  const before = await resolveManagedInvocation({ POSTPLUS_INSTALL_ROOT: root });
  const next = await activate('0.2.13', '24.21.0');
  const after = await resolveManagedInvocation({ POSTPLUS_INSTALL_ROOT: root, PATH: '/hostile' });
  assert.notEqual(after.executable, before.executable);
  assert.ok(after.executable.endsWith(next.node));
  assert.ok(after.args[0]?.endsWith(next.cli));
  assert.equal(await readFile(before.executable, 'utf8'), 'fixture', 'old running process retains its immutable files');
  await writeFile(join(root, 'active'), 'broken');
  await assert.rejects(resolveManagedInvocation({ POSTPLUS_INSTALL_ROOT: root }), /Invalid PostPlus installation record/);
});
