import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import test from 'node:test';

// Exercise real inherited file descriptors in a child process: intercepting
// process.stdout.write cannot catch an installer's inherited stdout.
async function recover(options: { updateExit?: number; restart?: boolean; malformed?: boolean; human?: boolean; newSession?: boolean } = {}) {
  const source = `
    import { runPostPlusClientUpgradeRecovery } from './src/update-check.ts';
    import { runInteractiveCommand } from './src/command-runner.ts';
    const originalArgs = ['media', 'schema', '--json', 'two words', '& literal'];
    import { writeFailure } from './src/failure-contract.ts';
    try {
    const result = await runPostPlusClientUpgradeRecovery({
      originalArgs,
      payload: { code: 'postplus_client_upgrade_required', compatibility: {
        upgrade: { skills: { required: true }, restartAgentSession: ${options.restart === true} }
      } }
    }, {
      environment: { ...process.env, POSTPLUS_CLIENT_RECOVERY_ATTEMPT: '' },
      runInteractiveCommand: async (command, args, options) => {
        const script = args[0] === 'update'
          ? ${JSON.stringify(`console.log(${JSON.stringify(options.malformed ? 'broken JSON' : JSON.stringify((options.updateExit ?? 0) === 0 ? {ok:true, session:{newSessionRequired:options.newSession === true,action:options.newSession ? 'Start a new agent session before using updated skills.' : null}} : {ok:false,error:{code:options.human?'postplus_requires_human':'postplus_cli_update_failed',stage:'npm-install',service:'npm',correlationId:'fixture-id',retryable:false,message:'Update stopped.',action:'Review the installation.',cause:[{name:'Error',code:'EACCES',message:'npm permission denied'}]}}))}); console.error('installer stderr'); process.exitCode = ${options.updateExit ?? 0};`)}
          : 'process.stdout.write(JSON.stringify({ok:true,args:process.argv.slice(1)}));';
        return runInteractiveCommand(process.execPath, ['-e', script, '--', ...args], options);
      }
    });
    process.exitCode = result.exitCode;
    } catch (error) { writeFailure(error, {json:true}); process.exitCode=1; }
  `;
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

test('automatic recovery keeps the complete original JSON stdout parseable', async (t) => {
  const result = await recover();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    args: ['media', 'schema', '--json', 'two words', '& literal'],
  });
  assert.match(result.stderr, /PostPlus is updating/);
  assert.doesNotMatch(result.stderr, /installer (stdout|stderr)|Updated skills need a new agent session/);
  t.diagnostic(`exit=${result.code}; stdout=${JSON.stringify(result.stdout)}`);
});

test('failed maintenance preserves structured npm failure and original cause', async () => {
  const result = await recover({ updateExit: 23 });
  assert.equal(result.code, 1);
  const fact = JSON.parse(result.stdout).error;
  assert.equal(fact.code, 'postplus_cli_update_failed');
  assert.equal(fact.stage, 'npm-install');
  assert.match(fact.action, /Stop automatic recovery/);
  assert.equal(fact.retryable, false);
  assert.equal(fact.correlationId, 'fixture-id');
  assert.ok(fact.cause.some((item: {code: string}) => item.code === 'EACCES'));
  assert.doesNotMatch(result.stderr, /installer stderr/);
});
test('requires-human remains actionable without replay', async () => {
  const result = await recover({updateExit:1, human:true});
  assert.equal(JSON.parse(result.stdout).error.code, 'postplus_requires_human');
  assert.equal(result.code, 1);
});
test('malformed update JSON fails closed without replay', async () => {
  const result = await recover({updateExit:1, malformed:true});
  assert.equal(JSON.parse(result.stdout).error.code, 'postplus_update_response_invalid');
  assert.match(JSON.parse(result.stdout).error.action, /do not run another update/);
  assert.doesNotMatch(JSON.parse(result.stdout).error.action, /postplus update --json/);
  assert.equal(result.code, 1);
});

test('restart-required maintenance leaves stdout empty without replay', async (t) => {
  const result = await recover({ restart: true });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /requires a new agent session/);
  t.diagnostic(`exit=${result.code}; stdout=${JSON.stringify(result.stdout)}`);
});


test('successful skills update advises a new session once without blocking authorized replay', async () => {
  const result = await recover({newSession:true});
  assert.equal(result.code,0);
  assert.equal(JSON.parse(result.stdout).ok,true);
  assert.equal(result.stderr.match(/Updated skills need a new agent session/g)?.length,1);
  assert.match(result.stderr,/Start a new agent session before using updated skills/);
});
test('malformed successful update fails closed without replay', async () => {
  const result = await recover({malformed:true});
  assert.equal(result.code,1);
  assert.equal(JSON.parse(result.stdout).error.code,'postplus_update_response_invalid');
});


test('real CLI-only update continuation emits a valid success envelope', async (t) => {
  const config = await mkdtemp(join(tmpdir(), 'postplus-cli-only-json-'));
  t.after(() => rm(config, {recursive:true,force:true}));
  const result = await promisify(execFile)(process.execPath, ['--import','tsx','src/index.ts','update','--json'], {
    env: {...process.env, POSTPLUS_CONFIG_DIR:config, POSTPLUS_CLIENT_RECOVERY_COMPONENTS:'cli', POSTPLUS_CLIENT_RECOVERY_ATTEMPT:'1', POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION:'0.0.0'},
  });
  assert.deepEqual(JSON.parse(result.stdout), {ok:true,command:'update',components:['cli']});
});

test('ordinary failure in a real recovery child returns one stopped JSON envelope', async () => {
  const result = await new Promise<{stdout:string;stderr:string;code:number|null}>((resolve,reject) => {
    const child = spawn(process.execPath, ['--import','tsx','src/index.ts','doctor','--not-an-option','--json'], {
      env:{...process.env,POSTPLUS_CLIENT_RECOVERY_ATTEMPT:'1'},
      stdio:['ignore','pipe','pipe'],
    });
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',reject);
    child.on('close',code=>resolve({stdout,stderr,code}));
  });
  assert.equal(result.code,1,result.stderr);
  const failure=JSON.parse(result.stdout).error;
  assert.match(failure.action,/^Stop automatic recovery/);
  assert.match(failure.action,/requires the user/);
  assert.match(failure.action,/postplus doctor --help/);
  assert.equal(failure.retryable,false);
});
