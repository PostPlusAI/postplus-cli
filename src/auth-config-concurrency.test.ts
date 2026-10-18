import { once } from 'node:events';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, test, mock } from 'node:test';
import { refreshRemoteAuthSession } from './auth-session.js';
import { clearLocalAuthState, readLocalConfig, updateLocalConfig, writeLocalConfig } from './local-state.js';

let root: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.POSTPLUS_CONFIG_DIR;
  root = await mkdtemp(join(tmpdir(), 'postplus-config-concurrency-'));
  process.env.POSTPLUS_CONFIG_DIR = root;
  await writeLocalConfig({cliSessionToken:'old-session',apiBaseUrl:'https://postplus.io',sessionApiBaseUrl:'https://postplus.io',userId:'user',accountId:'account'});
});
afterEach(async () => {
  mock.restoreAll();
  if (previous === undefined) delete process.env.POSTPLUS_CONFIG_DIR;
  else process.env.POSTPLUS_CONFIG_DIR = previous;
  await rm(root,{recursive:true,force:true});
});

function holdRefresh() {
  let arrived!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { arrived=resolve; });
  const gate = new Promise<void>((resolve) => { release=resolve; });
  mock.method(globalThis,'fetch',async () => {
    arrived();
    await gate;
    return Response.json({accountId:'account',accountName:'Account',accountSlug:null,accountType:'personal',cliSessionToken:'refreshed-session',sessionExpiresAt:null,userEmail:null,userId:'user'});
  });
  return {started,release};
}

test('in-flight refresh cannot undo a completed logout', async () => {
  const gate=holdRefresh();
  const refresh=refreshRemoteAuthSession();
  const rejected=assert.rejects(refresh,{code:'postplus_auth_state_changed'});
  await gate.started;
  await clearLocalAuthState();
  gate.release();
  await rejected;
  assert.equal((await readLocalConfig())?.cliSessionToken,undefined);
});

test('in-flight refresh cannot replace a newer login', async () => {
  const gate=holdRefresh();
  const refresh=refreshRemoteAuthSession();
  const rejected=assert.rejects(refresh,{code:'postplus_auth_state_changed'});
  await gate.started;
  await updateLocalConfig((current) => ({...current,cliSessionToken:'new-login'}));
  gate.release();
  await rejected;
  assert.equal((await readLocalConfig())?.cliSessionToken,'new-login');
});

test('unrelated config change is preserved while a valid refresh succeeds', async () => {
  const gate=holdRefresh();
  const refresh=refreshRemoteAuthSession();
  await gate.started;
  await updateLocalConfig((current) => ({...current,largeCreditConfirmation:{acknowledgedTierMillicreditsByAccountId:{account:123}}}));
  gate.release();
  await refresh;
  const result=await readLocalConfig();
  assert.equal(result?.cliSessionToken,'refreshed-session');
  assert.equal(result?.largeCreditConfirmation?.acknowledgedTierMillicreditsByAccountId?.account,123);
});

test('independent processes preserve every concurrent read-modify-write field', async () => {
  await Promise.all(Array.from({length:6},(_,index) => promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',`
    import {updateLocalConfig} from './src/local-state.ts';
    await updateLocalConfig(current => ({...current,largeCreditConfirmation:{acknowledgedTierMillicreditsByAccountId:{...current?.largeCreditConfirmation?.acknowledgedTierMillicreditsByAccountId, [${index}]:${index}}}}));
  `],{env:{...process.env,POSTPLUS_CONFIG_DIR:root}})));
  assert.equal(Object.keys((await readLocalConfig())?.largeCreditConfirmation?.acknowledgedTierMillicreditsByAccountId ?? {}).length,6);
});

test('a token resolved before logout cannot start a refresh against the cleared state', async () => {
  await clearLocalAuthState();
  const fetch = mock.method(globalThis,'fetch',async () => { throw new Error('Unexpected network'); });
  await assert.rejects(refreshRemoteAuthSession({cliSessionToken:'old-session'}),{code:'postplus_auth_state_changed'});
  assert.equal(fetch.mock.callCount(),0);
  assert.equal((await readLocalConfig())?.cliSessionToken,undefined);
});

async function holdConfigWriter() {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import {writeSync} from 'node:fs';
    import {updateLocalConfig} from './src/local-state.ts';
    await updateLocalConfig(current => {
      writeSync(1, 'held');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000);
      return current;
    });
  `], { env: { ...process.env, POSTPLUS_CONFIG_DIR: root }, stdio: ['ignore','pipe','pipe'] });
  await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(() => { throw new Error('writer exited before holding lock'); })]);
  return child;
}

async function killWriter(child: ReturnType<typeof spawn>) {
  const stopped = once(child, 'exit');
  child.kill('SIGKILL');
  await stopped;
}

test('a real dead config writer is reclaimed by competing writers without losing a generation', async () => {
  const child = await holdConfigWriter();
  await killWriter(child);
  const oldOwner = (await readdir(join(root,'config.lock')))[0]!;
  await Promise.all(Array.from({length:6},(_,index) => promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',`
    import {updateLocalConfig} from './src/local-state.ts';
    await updateLocalConfig(current => ({...current,largeCreditConfirmation:{acknowledgedTierMillicreditsByAccountId:{...current?.largeCreditConfirmation?.acknowledgedTierMillicreditsByAccountId,[${index}]:${index}}}}));
  `],{env:{...process.env,POSTPLUS_CONFIG_DIR:root}})));
  assert.equal(Object.keys((await readLocalConfig())?.largeCreditConfirmation?.acknowledgedTierMillicreditsByAccountId ?? {}).length,6);
  assert.ok(oldOwner.startsWith('owner-'));
  await assert.rejects(readdir(join(root,'config.lock')), {code:'ENOENT'});
});

test('a live config writer is never reclaimed', async () => {
  const child = await holdConfigWriter();
  try {
    const owner = await readdir(join(root,'config.lock'));
    await assert.rejects(updateLocalConfig(current => current!), {code:'postplus_config_busy'});
    assert.deepEqual(await readdir(join(root,'config.lock')), owner);
  } finally { await killWriter(child); }
  await updateLocalConfig(current => current!);
});

for (const record of ['corrupt', 'empty'] as const) {
  test(`unknown ${record} config lock is preserved`, async () => {
    const lock = join(root,'config.lock');
    await mkdir(lock);
    const name = 'owner-00000000-0000-0000-0000-000000000000.json';
    if (record === 'corrupt') await writeFile(join(lock,name), '{');
    await assert.rejects(updateLocalConfig(current => current!), {code:'postplus_config_busy'});
    assert.deepEqual(await readdir(lock), record === 'corrupt' ? [name] : []);
    if (record === 'corrupt') assert.equal(await readFile(join(lock,name),'utf8'), '{');
  });
}
