import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const connection = '00000000-0000-4000-8000-000000000001';
// Launch the compiled public entry and its real update/replay runner. Only HTTP
// and the installer are fixtures; no real account, installation or spend is used.
const commands = [
  ['channels', 'list'], ['channels', 'show', connection],
  ['channels', 'connect', 'meta-ads'], ['channels', 'disconnect', connection],
  ['channels', 'wait', connection], ['channels', 'tools', 'list'],
  ['channels', 'tools', 'show', 'METAADS_GET_AD_ACCOUNTS'],
  ['workspace', 'list'], ['workspace', 'use', 'next-account'], ['balance'], ['runs', 'list'],
  ['channels', 'tools', 'run', '--status', 'original-operation'],
  ['channels', 'tools', 'run', 'METAADS_GET_AD_ACCOUNTS', '--connection', connection,
    '--input-file', '@input', '--operation-id', 'original-operation'],
];
const cases = [
  ...commands.map((args) => ({ args, scenario: 'success' })),
  {args: ['channels', 'tools', 'run', 'METAADS_GET_AD_ACCOUNTS', '--connection', connection,
    '--input-file', '@input', '--operation-id', 'original-operation', '--wait'], scenario: 'poll-upgrade'},
  ...['update-fails', 'repeat', 'unknown-write'].map((scenario) => ({
    args: scenario === 'unknown-write' ? ['channels', 'connect', 'meta-ads'] : ['channels', 'list'], scenario,
  })),
];
for (const { args, scenario } of cases) {
  test(`real CLI automatically upgrades and continues ${args.join(' ')}: ${scenario}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'postplus-channel-upgrade-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = join(root, 'config');
    await mkdir(config);
    await writeFile(join(config, 'config.json'), JSON.stringify({
      apiBaseUrl: 'https://postplus.test', sessionApiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'fixture-token', sessionExpiresAt: null,
      userId: 'fixture-user', accountId: 'fixture-account',
    }), { mode: 0o600 });
    const input = join(root, 'input.json');
    await writeFile(input, '{}');
    const statePath = join(root, 'state.json');
    await writeFile(statePath, JSON.stringify({ updates: 0, requests: [] }));
    const fixture = join(root, 'fixture.mjs');
    await writeFile(fixture, `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs';
      const filename = ${JSON.stringify(statePath)};
      const read = () => JSON.parse(readFileSync(filename, 'utf8'));
      const save = (s) => writeFileSync(filename, JSON.stringify(s));
      if (process.argv[2] === 'update') {
        const s = read(); s.updates++; save(s);
        if (${JSON.stringify(scenario)} === 'update-fails') {
          console.log(JSON.stringify({ok:false,error:{code:'postplus_cli_update_failed',stage:'update',service:'cli',message:'fixture update failure',action:'Stop.',retryable:false,cause:[]}})); process.exit(1);
        }
        console.log(JSON.stringify({ok:true})); process.exit(0);
      }
      globalThis.fetch = async (url, init) => {
        assert.ok(String(url).startsWith('https://postplus.test/'), 'unexpected network request');
        const s = read(); s.requests.push({ url:String(url), method:init.method, body:init.body }); save(s);
        if (${JSON.stringify(scenario)} === 'unknown-write') throw new TypeError('fetch failed');
        if (${JSON.stringify(scenario)} === 'poll-upgrade') {
          if (JSON.parse(init.body).operation === 'execute-tool')
            return Response.json({output:{status:'running'}});
          return Response.json({code:'postplus_client_upgrade_required'}, {status:426});
        }
        if (s.updates === 0 || ${JSON.stringify(scenario)} === 'repeat') return Response.json({code:'postplus_client_upgrade_required',
          compatibility:{upgrade:{cli:{required:true},restartAgentSession:true}}
        }, {status:426});
        return Response.json({marker:'original-task-completed',connection:{status:'active'},
          accountId:'next-account',userId:'fixture-user',cliSessionToken:'new-fixture-token',
          sessionExpiresAt:Date.now()+3600000,accountName:'Next account',accountType:'personal'});
      };
    `);
    const result = await exec(process.execPath, [resolve('build/index.js'), ...args.map((arg) => arg === '@input' ? input : arg), '--json'], {
      timeout: 30_000,
      env: { ...process.env, POSTPLUS_CONFIG_DIR: config,
        POSTPLUS_API_BASE_URL: 'https://postplus.test', POSTPLUS_INSTALL_ROOT: '',
        POSTPLUS_CLIENT_RECOVERY_ATTEMPT: '',
        NODE_OPTIONS: `--import=${JSON.stringify(fixture)}` },
    }).then((result) => ({ ...result, code: 0 }), (error: {stdout:string;stderr:string;code:number}) => error);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (scenario !== 'success') {
      assert.equal(result.code, ['unknown-write','poll-upgrade'].includes(scenario) ? 2 : 1, result.stdout);
      assert.equal(state.updates, ['unknown-write','poll-upgrade'].includes(scenario) ? 0 : 1);
      assert.equal(state.requests.length, ['repeat','poll-upgrade'].includes(scenario) ? 2 : 1);
      const failure = JSON.parse(result.stdout);
      if (['unknown-write','poll-upgrade'].includes(scenario)) assert.equal(failure.execution.resultStatus, 'unknown');
      else assert.equal(failure.ok, false);
      return;
    }
    assert.equal(result.code, 0, result.stdout);
    const value = JSON.parse(result.stdout);
    if (args[0] === 'workspace' && args[1] === 'use')
      assert.equal(value.accountId, 'next-account');
    else if (args[0] !== 'balance' && args[0] !== 'runs')
      assert.equal(value.marker, 'original-task-completed');
    assert.equal(state.updates, 1);
    assert.equal(state.requests.length, 2);
    assert.deepEqual(state.requests[0], state.requests[1], 'same original request after update');
  });
}
