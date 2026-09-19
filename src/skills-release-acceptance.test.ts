import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// With POSTPLUS_TEST_RELEASE_CLI set, the same journey exercises an unpacked
// distributable. Otherwise it exercises current source, never stale build/.
test('official full bundle installs and verifies without GitHub or a remote catalog', { timeout: 180_000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'postplus-full-bundle-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(home); await mkdir(project);
  const attempts = join(root, 'network-attempts');
  const preload = join(root, 'offline.cjs');
  await writeFile(preload, `
    const fs = require('node:fs');
    const deny = () => { fs.appendFileSync(${JSON.stringify(attempts)}, 'attempt\\n'); throw new Error('Network forbidden in full bundle acceptance'); };
    globalThis.fetch = deny;
    for (const name of ['node:http', 'node:https']) { const m = require(name); m.request = deny; m.get = deny; }
    const net = require('node:net'); const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      const options = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (options && typeof options === 'object' && typeof options.path === 'string') return connect.apply(this, args);
      return deny();
    };
    require('node:module').syncBuiltinESMExports();
  `);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.state'),
    POSTPLUS_CONFIG_DIR: join(home, '.postplus'),
    DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
  };
  const entry = process.env.POSTPLUS_TEST_RELEASE_CLI;
  const baseArgs = entry ? [entry] : ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./index.ts', import.meta.url))];
  const packageRoot = entry ? dirname(dirname(resolve(entry))) : fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await readFile(join(packageRoot, 'bundled-skills/skills-manifest.json'), 'utf8'));
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...baseArgs, ...args], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const first = await run(['install', '--json']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(JSON.parse(first.stdout).releaseId, manifest.releaseId);
  assert.equal(JSON.parse(first.stdout).skillCount, manifest.skills.length);
  const baseline = await readFile(join(home, '.postplus-skills.json'), 'utf8');
  const repeated = await run(['install', '--json']);
  assert.equal(repeated.code, 0, repeated.stdout + repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).outcome, 'current');
  assert.equal(await readFile(join(home, '.postplus-skills.json'), 'utf8'), baseline);
  const verified = await run(['skills', 'verify', '--json']);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  const report = JSON.parse(verified.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.verifiedSkillsReleaseId, manifest.releaseId);
  assert.equal(report.requiredCount, manifest.skills.length);
  assert.equal(report.installedCount, manifest.skills.length);
  await assert.rejects(readFile(attempts), { code: 'ENOENT' });
  t.diagnostic(`skills=${manifest.skills.length}; release=${manifest.releaseId}; first/repeat/verify=0; network attempts=0; scope=global`);
});
