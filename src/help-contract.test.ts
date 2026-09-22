import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildVerbTargetIndex } from './hosted-manifest-index.js';

const exec = promisify(execFile);
const paths: string[][] = [[], ...['doctor', 'status', 'list', 'version', 'install', 'update', 'uninstall', 'auth', 'skills', 'quote', 'balance', 'runs', 'studio', 'research', 'media', 'publish', 'media-file'].map(x => [x]),
  ...['login', 'refresh', 'revoke', 'status', 'validate', 'logout'].map(x => ['auth', x]),
  ['skills', 'verify'], ['quote', 'confirm'], ['runs', 'list'], ['runs', 'show'],
  ...['init', 'open', 'status'].map(x => ['studio', x]),
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
    const cases = [...paths.flatMap(path => [[...path, '--help'], [...path, '-h'], ['help', ...path]]), ['list'], ['list', '--json']];
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

test('bundled discovery is available even when the account config location is unusable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'postplus-discovery-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const occupied = join(directory, 'occupied');
  await writeFile(occupied, 'Keep this existing file.');
  const env = { ...process.env, HOME: directory, POSTPLUS_CONFIG_DIR: occupied };
  for (const args of [['list'], ['list', '--json']]) {
    const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', resolve('src/index.ts'), ...args], { env });
    assert.equal(stderr, '');
    assert.ok(stdout.length > 0);
    if (args.includes('--json')) assert.ok(JSON.parse(stdout).skills.length > 0);
  }
  // Control: commands that use account state must still reject the invalid location.
  await assert.rejects(exec(process.execPath, ['--import', 'tsx', resolve('src/index.ts'), 'status', '--json'], { env }));
  assert.equal(await readFile(occupied, 'utf8'), 'Keep this existing file.');
  assert.deepEqual(await readdir(directory), ['occupied']);
});

test('invalid options suggest the nearest valid command help and diagnostics explain scope', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'postplus-help-errors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { env: { ...process.env, HOME: directory, POSTPLUS_CONFIG_DIR: directory, POSTPLUS_ACCESS_TOKEN: '', POSTPLUS_REFRESH_TOKEN: '' } };
  for (const path of [['doctor'], ['auth', 'status'], ['skills', 'verify'], ['runs', 'list'], ['studio', 'open']]) {
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


test('unknown public subcommands return one JSON failure and a valid family help action', async () => {
  for (const command of ['publish','media','research','studio','runs','media-file']) {
    await assert.rejects(exec(process.execPath,['--import','tsx','src/index.ts',command,'not-a-command','--json']), (error:any) => {
      const payload=JSON.parse(error.stdout);
      assert.equal(payload.ok,false,command);
      assert.equal(payload.error.code,'postplus_invalid_arguments',command);
      assert.equal(payload.error.action,`Run postplus ${command} --help.`,command);
      return true;
    });
  }
});

test('retired workflow commands are rejected as unknown top-level commands', async () => {
  await assert.rejects(
    exec(process.execPath, [
      '--import', 'tsx', 'src/index.ts', 'workflow', 'list', '--json',
    ]),
    (error: any) => {
      assert.equal(error.stderr, '');
      const failure = JSON.parse(error.stdout);
      assert.equal(failure.ok, false);
      assert.equal(failure.error.code, 'postplus_unknown_command');
      assert.match(failure.error.message, /Unknown command: workflow/u);
      assert.equal(failure.error.action, 'Run postplus --help.');
      return true;
    },
  );
});


test('unauthenticated doctor preserves the login action and local checks in JSON', async (t) => {
  const directory=await mkdtemp(join(tmpdir(),'postplus-no-session-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await assert.rejects(exec(process.execPath,['--import','tsx','src/index.ts','doctor','--json'],{
    env:{...process.env,POSTPLUS_CONFIG_DIR:directory,POSTPLUS_CLI_SESSION_TOKEN:''},
  }), (error:any) => {
    const report=JSON.parse(error.stdout);
    const auth=report.checks.find((check:any)=>check.id==='remote_auth');
    assert.equal(auth.failure.code,'postplus_auth_required');
    assert.equal(auth.failure.action,'Run postplus auth login.');
    assert.ok(report.checks.some((check:any)=>check.id==='local_dependencies'));
    return true;
  });
});


test('package discovery and maintenance help keep the original task without shared onboarding', async () => {
  const { stdout: top } = await exec(process.execPath, ['--import', 'tsx', 'src/index.ts', '--help']);
  const catalog = JSON.parse(await readFile('bundled-skills/skills/catalog.json', 'utf8'));
  assert.ok(top.includes(catalog.productBrief.paragraphs[0]));
  assert.match(top, /postplus install → postplus list/);
  for (const command of ['install', 'update']) {
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', 'src/index.ts', command, '--help', '--json']);
    const help = JSON.parse(stdout);
    assert.match(help.next, /paste the original request/);
    assert.match(help.next, /Otherwise, describe the task/);
    assert.doesNotMatch(help.next, /Help me get started|postplus-shared/);
  }
});
