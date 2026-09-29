import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { decodeInstallation } from '../runtime-manager/state.mjs';
const exec = promisify(execFile);

test('old managed Node and manager activate a new CLI/runtime pair only after verification', { timeout: 180000 }, async t => {
  const { POSTPLUS_TEST_OLD_CANDIDATE: old, POSTPLUS_TEST_NEW_CANDIDATE: next,
    POSTPLUS_TEST_OLD_NODE_ARCHIVE: oldNode, POSTPLUS_TEST_NODE_ARCHIVE: nextNode } = process.env;
  assert.ok(old && next && oldNode && nextNode, 'both real candidates and official Node archives are required');
  const root = await mkdtemp(join(tmpdir(), 'postplus upgrade '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unpacked = join(root, 'unpacked');
  await mkdir(unpacked);
  const previousRelease = JSON.parse(await readFile(join(old, 'postplus-runtime.json'), 'utf8'));
  const nextRelease = JSON.parse(await readFile(join(next, 'postplus-runtime.json'), 'utf8'));
  assert.notEqual(previousRelease.cliVersion, nextRelease.cliVersion);
  // Test-only historical pairing; this is not a published release manifest.
  previousRelease.node = { version: '24.5.0', artifacts: { 'darwin-arm64': {
    directory: 'node-v24.5.0-darwin-arm64',
    url: 'https://nodejs.org/dist/v24.5.0/node-v24.5.0-darwin-arm64.tar.gz',
    sha256: '2a4172474565ecb8f0c87a1520590e00d6b28a78594c220d38eef991763dc276',
  } } };
  assert.equal(process.platform + '-' + process.arch, 'darwin-arm64', 'this evidence fixture is macOS ARM64 only');
  const oldArchive = join(old, `postplus-cli-v${previousRelease.cliVersion}.tar.gz`);
  const nextArchive = join(next, `postplus-cli-v${nextRelease.cliVersion}.tar.gz`);
  await exec('tar', ['-xzf', oldArchive, '-C', unpacked]);
  const releaseFile = join(root, 'old.json');
  await writeFile(releaseFile, JSON.stringify(previousRelease));
  const installRoot = join(root, 'managed');
  const home = join(root, 'home');
  await mkdir(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), POSTPLUS_CONFIG_DIR: join(home, 'config'), POSTPLUS_INSTALL_ROOT: installRoot };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const invoke = (node, manager, command, manifest, cli, runtime) => exec(node, [manager, command, '--root', installRoot,
    '--release-file', manifest, '--cli-archive', cli, '--node-archive', runtime], { env, cwd: home, timeout: 120000 });
  await invoke(process.execPath, join(unpacked, 'postplus-cli/runtime-manager/index.mjs'), 'install', releaseFile, oldArchive, oldNode);
  const beforeBytes = await readFile(join(installRoot, 'active'), 'utf8');
  const before = decodeInstallation(beforeBytes);
  const oldExecutable = join(installRoot, before.node);
  const oldManager = join(installRoot, before.manager);
  const damaged = join(root, 'damaged.tar.gz');
  await writeFile(damaged, 'truncated download');
  await assert.rejects(invoke(oldExecutable, oldManager, 'update', join(next, 'postplus-runtime.json'), damaged, nextNode));
  assert.equal(await readFile(join(installRoot, 'active'), 'utf8'), beforeBytes, 'failed update keeps original selection');
  assert.equal((await exec(join(installRoot, 'bin/postplus'), ['--version'], { env })).stdout.trim(), previousRelease.cliVersion);
  const driver = join(root, 'update-driver.mjs');
  await writeFile(driver, `
    import { readFile } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    const { updateManagedInstallation } = await import(pathToFileURL(${JSON.stringify(join(installRoot, before.cli, '..', 'managed-runtime.js'))}).href);
    const release = ${JSON.stringify(nextRelease)};
    const result = await updateManagedInstallation({ environment: process.env, continuationArgs: ['--json'],
      currentCliEntryPath: ${JSON.stringify(join(installRoot, before.cli))},
      fetchFn: async url => {
        if (String(url) === 'https://postplus.io/postplus-runtime.json') return Response.json(release);
        if (String(url) === release.cli.url) return new Response(await readFile(${JSON.stringify(nextArchive)}));
        if (String(url) === release.node.artifacts['darwin-arm64'].url) return new Response(await readFile(${JSON.stringify(nextNode)}));
        throw new Error('Unexpected external request: ' + url);
      },
    });
    if (result.exitCode !== 0 || result.latestVersion !== release.cliVersion) process.exitCode = 1;
  `);
  const updated = JSON.parse((await exec(oldExecutable, [driver], { env, cwd: home, timeout: 120000 })).stdout);
  assert.equal(updated.ok, true);
  assert.equal(updated.diskReady, true);
  assert.equal(updated.releaseId, nextRelease.skillsReleaseId);
  const after = decodeInstallation(await readFile(join(installRoot, 'active'), 'utf8'));
  assert.equal(after.cliVersion, nextRelease.cliVersion);
  assert.equal(after.nodeVersion, nextRelease.node.version);
  assert.notEqual(after.node, before.node);
  assert.notEqual(after.manager, before.manager);
  assert.equal((await exec(join(installRoot, 'bin/postplus'), ['--version'], { env })).stdout.trim(), nextRelease.cliVersion);
  assert.equal((await exec(oldExecutable, ['--version'], { env })).stdout.trim(), 'v24.5.0', 'old in-use runtime remains available');
  const verified = JSON.parse((await exec(join(installRoot, 'bin/postplus'), ['skills', 'verify', '--json'], { env, cwd: home })).stdout);
  assert.equal(verified.ok, true);
  assert.equal(verified.verifiedSkillsReleaseId, nextRelease.skillsReleaseId);
  t.diagnostic(`${before.cliVersion}/Node ${before.nodeVersion} -> ${after.cliVersion}/Node ${after.nodeVersion}; failed update preserved active selection`);
});
