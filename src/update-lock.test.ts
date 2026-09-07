import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runInteractiveCommand } from './command-runner.js';
import { withPostPlusUpdateLock } from './local-state.js';

const moduleUrl = new URL('./local-state.ts', import.meta.url).href;

test(
  'installer signal interruption retains the lock even while the owning CLI is alive',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'postplus-lock-test-'));
    const pidFile = join(root, 'installer-child.pid');
    let descendantPid: number | undefined;
    try {
      await assert.rejects(
        withPostPlusUpdateLock(
          () =>
            runInteractiveCommand(process.execPath, [
              '-e',
              `
      const child = require('node:child_process').spawn(process.execPath, ['-e','setInterval(() => {}, 1000)'], {stdio:'ignore'});
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      process.kill(process.pid, 'SIGTERM');
    `,
            ]),
          { installationRoot: root },
        ),
        /postplus_update_installation_uncertain/,
      );
      descendantPid = Number(await readFile(pidFile, 'utf8'));
      process.kill(descendantPid, 0);
      const owners = await readdir(join(root, '.postplus-cli-update.lock'));
      assert.equal(owners.length, 1);
      let entered = false;
      await assert.rejects(
        withPostPlusUpdateLock(
          async () => {
            entered = true;
          },
          { installationRoot: root, timeoutMs: 100, pollMs: 10 },
        ),
        /Another PostPlus update is still running/,
      );
      assert.equal(entered, false);
    } finally {
      if (!descendantPid) {
        try {
          descendantPid = Number(await readFile(pidFile, 'utf8'));
        } catch {}
      }
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
type Event = { kind: string; pid?: number; message?: string };

function updater(config: string, installationRoot: string, installer = false) {
  const events: Event[] = [];
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { spawn } from 'node:child_process';
    const { withPostPlusUpdateLock } = await import(${JSON.stringify(moduleUrl)});
    process.send({kind:'attempting'});
    try {
      await withPostPlusUpdateLock(async () => {
        process.send({kind:'entered'});
        if (${installer}) {
          const installer = spawn(process.execPath, ['-e','setInterval(() => {}, 1000)'], {stdio:'ignore'});
          process.send({kind:'installer',pid:installer.pid});
        }
        await new Promise(resolve => process.once('message', resolve));
      }, { installationRoot: ${JSON.stringify(installationRoot)}, pollMs: 10, timeoutMs: 5000 });
      process.send({kind:'done'});
    } catch (error) { process.send({kind:'failed',message:error.message}); }
    process.disconnect();
  `,
    ],
    {
      env: { ...process.env, POSTPLUS_CONFIG_DIR: config },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('message', (event: Event) => events.push(event));
  async function wait(kind: string): Promise<Event> {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const event = events.find((item) => item.kind === kind);
      if (event) return event;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Updater exited before ${kind}: ${stderr}; ${JSON.stringify(events)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Updater did not emit ${kind}: ${stderr}; ${JSON.stringify(events)}`,
    );
  }
  return { child, events, wait };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  await closed;
}

test(
  'same installation serializes updates from different account configs',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'postplus-lock-test-'));
    const a = updater(join(root, 'account-a'), join(root, 'npm'));
    let b: ReturnType<typeof updater> | undefined;
    try {
      await a.wait('entered');
      b = updater(join(root, 'account-b'), join(root, 'npm'));
      await b.wait('attempting');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(
        b.events.some((event) => event.kind === 'entered'),
        false,
      );
      a.child.send('release');
      await a.wait('done');
      await b.wait('entered');
      b.child.send('release');
      await b.wait('done');
      assert.deepEqual(await readdir(join(root, 'npm')), []);
    } finally {
      await stop(a.child);
      if (b) await stop(b.child);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'different installation targets are not serialized by a shared account config',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'postplus-lock-test-'));
    const a = updater(join(root, 'account'), join(root, 'npm-a'));
    const b = updater(join(root, 'account'), join(root, 'npm-b'));
    try {
      await Promise.all([a.wait('entered'), b.wait('entered')]);
      a.child.send('release');
      b.child.send('release');
      await Promise.all([a.wait('done'), b.wait('done')]);
    } finally {
      await stop(a.child);
      await stop(b.child);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'parent death never permits a second installer while its child survives',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'postplus-lock-test-'));
    const npmRoot = join(root, 'npm');
    const a = updater(join(root, 'account-a'), npmRoot, true);
    let installerPid: number | undefined;
    let b: ReturnType<typeof updater> | undefined;
    try {
      installerPid = (await a.wait('installer')).pid;
      assert.ok(installerPid);
      await stop(a.child);
      process.kill(installerPid, 0);
      b = updater(join(root, 'account-b'), npmRoot);
      const failed = await b.wait('failed');
      assert.match(failed.message!, /postplus_update_installation_uncertain/);
      assert.equal(
        b.events.some((event) => event.kind === 'entered'),
        false,
      );
      const owners = await readdir(join(npmRoot, '.postplus-cli-update.lock'));
      assert.equal(owners.length, 1);
      assert.equal(
        JSON.parse(
          await readFile(
            join(npmRoot, '.postplus-cli-update.lock', owners[0]!),
            'utf8',
          ),
        ).operationStarted,
        true,
      );
    } finally {
      await stop(a.child);
      if (b) await stop(b.child);
      if (installerPid) {
        try {
          process.kill(installerPid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'two processes reclaim an installation lock only when work had not started',
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'postplus-lock-test-'));
    const npmRoot = join(root, 'npm');
    const lock = join(npmRoot, '.postplus-cli-update.lock');
    await mkdir(lock, { recursive: true });
    // A process we observed exit supplies a real, dead owner PID.
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(dead, 'close');
    await writeFile(
      join(lock, 'owner-00000000-0000-0000-0000-000000000000.json'),
      JSON.stringify({ pid: dead.pid, operationStarted: false }),
    );
    const a = updater(join(root, 'a'), npmRoot);
    const b = updater(join(root, 'b'), npmRoot);
    try {
      const winner = await Promise.race([
        a.wait('entered').then(() => a),
        b.wait('entered').then(() => b),
      ]);
      const loser = winner === a ? b : a;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        loser.events.some((event) => event.kind === 'entered'),
        false,
      );
      winner.child.send('release');
      await winner.wait('done');
      await loser.wait('entered');
      loser.child.send('release');
      await loser.wait('done');
      assert.deepEqual(await readdir(npmRoot), []);
    } finally {
      await stop(a.child);
      await stop(b.child);
      await rm(root, { recursive: true, force: true });
    }
  },
);
