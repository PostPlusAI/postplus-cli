import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { activateInstallation, decodeInstallation, encodeInstallation, readInstallation, resolveManagedFile, withInstallationLock } from './state.mjs';
const exec = promisify(execFile);
const run = async (command, args) => (await exec(command, args, { env: { ...process.env, NODE_OPTIONS: '' } })).stdout;

async function fixture(t, version = '0.2.14') {
  const root = await mkdtemp(join(tmpdir(), 'postplus managed space '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = { cliVersion: version, nodeVersion: process.versions.node,
    node: `runtimes/node-v${process.versions.node}-${process.platform}-${process.arch}/${process.platform === 'win32' ? 'node.exe' : 'bin/node'}`,
    cli: `versions/${version}/build/index.js`, manager: `versions/${version}/runtime-manager/index.mjs` };
  for (const key of ['node', 'cli', 'manager']) await mkdir(dirname(join(root, value[key])), { recursive: true });
  await copyFile(process.execPath, join(root, value.node));
  await writeFile(join(root, value.cli), `console.log(${JSON.stringify(version)});`);
  await writeFile(join(root, value.manager), 'export {};');
  return { root, value };
}

test('managed installation verifies its own Node, ignoring system PATH', async t => {
  const { root, value } = await fixture(t);
  await withInstallationLock(root, () => activateInstallation(root, value, async (command, args) =>
    (await exec(command, args, { env: { PATH: '', NODE_OPTIONS: '' } })).stdout));
  assert.deepEqual(await readInstallation(root), value);
});

test('failed candidate verification preserves the previous active installation', async t => {
  const { root, value } = await fixture(t);
  await activateInstallation(root, value, run);
  const before = await readFile(join(root, 'active'), 'utf8');
  const candidate = { ...value, cliVersion: '0.2.15', cli: 'versions/0.2.15/build/index.js', manager: 'versions/0.2.15/runtime-manager/index.mjs' };
  for (const key of ['cli', 'manager']) await mkdir(dirname(join(root, candidate[key])), { recursive: true });
  await writeFile(join(root, candidate.cli), 'process.exit(9);');
  await writeFile(join(root, candidate.manager), 'export {};');
  await assert.rejects(activateInstallation(root, candidate, run));
  assert.equal(await readFile(join(root, 'active'), 'utf8'), before);
  assert.equal((await run(join(root, value.node), [join(root, value.cli), '--version'])).trim(), value.cliVersion);
});

test('record corruption and escaping paths are explicit failures', async t => {
  const { root, value } = await fixture(t);
  assert.deepEqual(decodeInstallation(encodeInstallation(value)), value);
  for (const node of ['../node', '/usr/bin/node', 'runtimes/../../node', 'runtimes/node\nmalicious', 'C:\\node.exe'])
    assert.throws(() => encodeInstallation({ ...value, node }));
  await writeFile(join(root, 'active'), '{}');
  await assert.rejects(readInstallation(root), /Invalid/);
  await symlink(process.execPath, join(root, 'external-node'));
  await assert.rejects(resolveManagedFile(root, 'external-node'), /managed file/);
});

test('concurrent update cannot enter the installation; failures release the lock', async t => {
  const { root } = await fixture(t);
  await assert.rejects(withInstallationLock(root, async () => {
    await assert.rejects(withInstallationLock(root, async () => assert.fail('entered twice'), { timeoutMs: 20, pollMs: 5 }), /still running/);
    throw new Error('download failed');
  }), /download failed/);
  assert.equal(await withInstallationLock(root, async () => 'ready'), 'ready');
});

test('installed POSIX launcher uses managed Node and preserves exact arguments', { skip: process.platform === 'win32' }, async t => {
  const { root, value } = await fixture(t);
  await activateInstallation(root, value, run);
  await mkdir(join(root, 'bin'));
  await copyFile(new URL('./launch.sh', import.meta.url), join(root, 'bin/postplus'));
  await writeFile(join(root, value.cli), 'console.log(JSON.stringify({args:process.argv.slice(2),root:process.env.POSTPLUS_INSTALL_ROOT}));');
  const args = ['with space', '"quote"', '$literal', ';exit 9', '中文'];
  const result = await exec('/bin/sh', [join(root, 'bin/postplus'), ...args], { env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require=/postplus-test-does-not-exist.cjs' } });
  assert.deepEqual(JSON.parse(result.stdout), { args, root: await import('node:fs/promises').then(fs => fs.realpath(root)) });
  await writeFile(join(root, 'active'), 'damaged\n');
  await assert.rejects(exec('/bin/sh', [join(root, 'bin/postplus')]), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /official PostPlus installer/);
    return true;
  });
});
