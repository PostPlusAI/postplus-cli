import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

// Exercise real inherited file descriptors in a child process: intercepting
// process.stdout.write cannot catch an installer's inherited stdout.
async function recover(options: { updateExit?: number; restart?: boolean } = {}) {
  const source = `
    import { runPostPlusClientUpgradeRecovery } from './src/update-check.ts';
    import { runInteractiveCommand } from './src/command-runner.ts';
    const originalArgs = ['media', 'schema', '--json', 'two words', '& literal'];
    const result = await runPostPlusClientUpgradeRecovery({
      originalArgs,
      payload: { code: 'postplus_client_upgrade_required', compatibility: {
        upgrade: { skills: { required: true }, restartAgentSession: ${options.restart === true} }
      } }
    }, {
      environment: { ...process.env, POSTPLUS_CLIENT_RECOVERY_ATTEMPT: '' },
      runInteractiveCommand: async (command, args, options) => {
        const script = args[0] === 'update'
          ? 'console.log("installer stdout"); console.error("installer stderr"); process.exitCode = ${options.updateExit ?? 0};'
          : 'process.stdout.write(JSON.stringify({ok:true,args:process.argv.slice(1)}));';
        return runInteractiveCommand(process.execPath, ['-e', script, '--', ...args], options);
      }
    });
    process.exitCode = result.exitCode;
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
  assert.match(result.stderr, /installer stdout/);
  assert.match(result.stderr, /installer stderr/);
  t.diagnostic(`exit=${result.code}; stdout=${JSON.stringify(result.stdout)}`);
});

test('failed maintenance leaves stdout empty and preserves its exit code', async (t) => {
  const result = await recover({ updateExit: 23 });
  assert.equal(result.code, 23);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /automatic update failed with exit code 23/);
  t.diagnostic(`exit=${result.code}; stdout=${JSON.stringify(result.stdout)}`);
});

test('restart-required maintenance leaves stdout empty without replay', async (t) => {
  const result = await recover({ restart: true });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /requires a new agent session/);
  t.diagnostic(`exit=${result.code}; stdout=${JSON.stringify(result.stdout)}`);
});
