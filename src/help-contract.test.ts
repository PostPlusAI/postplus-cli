import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildVerbTargetIndex } from './hosted-manifest-index.js';

const exec = promisify(execFile);
const paths: string[][] = [[], ...['doctor', 'status', 'list', 'version', 'install', 'update', 'uninstall', 'auth', 'skills', 'quote', 'balance', 'runs', 'studio', 'workflow', 'research', 'media', 'publish', 'media-file'].map(x => [x]),
  ...['login', 'refresh', 'revoke', 'status', 'validate', 'logout'].map(x => ['auth', x]),
  ['skills', 'verify'], ['quote', 'confirm'], ['runs', 'list'], ['runs', 'show'],
  ...['init', 'open', 'status'].map(x => ['studio', x]),
  ...['list', 'show', 'runs', 'run-show', 'create', 'propose', 'save', 'quote', 'launch'].map(x => ['workflow', x]),
  ...['research', 'media', 'publish'].map(x => [x, 'schema']),
  ['research', 'run'], ['media', 'estimate'], ['media', 'poll'], ['media', 'prepare'],
  ['media-file', 'upload'], ['media-file', 'download'],
];
for (const [verb, targets] of buildVerbTargetIndex('media')) {
  paths.push(['media', verb]);
  for (const target of targets.keys()) paths.push(['media', verb, target]);
}
for (const targets of buildVerbTargetIndex('research').values()) {
  for (const target of targets.keys()) paths.push(['research', 'run', target]);
}
for (const targets of buildVerbTargetIndex('publish').values()) {
  for (const target of targets.keys()) paths.push(['publish', target]);
}

test('every public help path and alias is offline and leaves account state untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'postplus-help-'));
  const config = join(directory, 'config.json');
  const guard = join(directory, 'offline.mjs');
  await writeFile(config, '{broken-on-purpose', { mode: 0o644 });
  await writeFile(guard, `import net from 'node:net'; import http from 'node:http'; import https from 'node:https'; import tls from 'node:tls'; import {syncBuiltinESMExports} from 'node:module'; const deny=()=>{throw new Error('Help attempted network access');}; globalThis.fetch=deny; net.Socket.prototype.connect=deny; http.request=deny; https.request=deny; tls.connect=deny; syncBuiltinESMExports();`);
  const initial = await stat(config);
  // Disable Node's startup proxy bootstrap only in this deliberately invalid
  // fixture. Otherwise Node can exit before our help entrypoint is loaded.
  const env = { ...process.env, HOME: directory, POSTPLUS_CONFIG_DIR: directory,
    POSTPLUS_ACCESS_TOKEN: '', POSTPLUS_REFRESH_TOKEN: '', NODE_USE_ENV_PROXY: '0', NODE_OPTIONS: '', https_proxy: 'unsupported://help-must-not-connect', HTTPS_PROXY: 'unsupported://help-must-not-connect' };
  try {
    // Four bounded children at a time; each runs the actual source entrypoint.
    const cases = paths.flatMap(path => [[...path, '--help'], [...path, '-h'], ['help', ...path]]);
    for (let i = 0; i < cases.length; i += 4) {
      await Promise.all(cases.slice(i, i + 4).map(async args => {
        const { stdout, stderr } = await exec(process.execPath,
          ['--import', guard, '--import', 'tsx', resolve('src/index.ts'), ...args],
          { env, timeout: 30000, maxBuffer: 1024 * 1024 });
        assert.match(stdout, /postplus/i, args.join(' '));
        assert.equal(stderr, '', args.join(' '));
      }));
    }
    assert.equal(await readFile(config, 'utf8'), '{broken-on-purpose');
    assert.equal((await stat(config)).mode, initial.mode);
    assert.deepEqual((await readdir(directory)).sort(), ['config.json', 'offline.mjs']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid options suggest the nearest valid command help and diagnostics explain scope', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'postplus-help-errors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { env: { ...process.env, HOME: directory, POSTPLUS_CONFIG_DIR: directory, POSTPLUS_ACCESS_TOKEN: '', POSTPLUS_REFRESH_TOKEN: '' } };
  for (const path of [['doctor'], ['auth', 'status'], ['skills', 'verify'], ['runs', 'list'], ['studio', 'open'], ['workflow', 'list']]) {
    await assert.rejects(exec(process.execPath, ['--import', 'tsx', 'src/index.ts', ...path, '--not-an-option', '--json'], options), (error: any) => {
      const failure = JSON.parse(error.stdout).error;
      assert.equal(failure.code, 'postplus_invalid_arguments');
      assert.equal(failure.action, `Run postplus ${path.join(' ')} --help.`);
      return true;
    });
  }
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'src/index.ts', 'doctor', '--help', '--json'], options);
  const help = JSON.parse(stdout);
  assert.equal(help.checks.length, 6);
  assert.equal(help.examples.length, 2);
  assert.match(help.related, /status includes doctor/);
  assert.match(help.results, /does not guarantee/);
  assert.match(help.next, /skills verify/);
});
