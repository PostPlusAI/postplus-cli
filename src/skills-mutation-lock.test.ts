import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

type Event = { kind: string; pid?: number; message?: string; result?: number };
const fixture = fileURLToPath(
  new URL('./fixtures/skills-mutation-lock.mjs', import.meta.url),
);
const loader = import.meta.resolve('tsx');
function mutation(
  root: string,
  config: string,
  home: string,
  cwd: string,
  scope = 'global',
  action = 'update',
  behavior = 'hold',
) {
  const events: Event[] = [];
  const child = spawn(
    process.execPath,
    ['--import', loader, fixture, action, scope, behavior],
    {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        POSTPLUS_CONFIG_DIR: join(root, config),
        POSTPLUS_PROFILE: config,
        XDG_STATE_HOME: join(root, `${config}-state`),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('message', (event: Event) => events.push(event));
  async function wait(kind: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const event = events.find((event) => event.kind === kind);
      if (event) return event;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Missing ${kind}: ${stderr}; ${JSON.stringify(events)}`);
  }
  return { child, events, wait };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  await closed;
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'postplus-skills-lock-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await Promise.all([mkdir(home), mkdir(project)]);
  return { root, home, project };
}

for (const scope of ['global', 'current-directory']) {
  for (const action of ['update', 'uninstall']) {
    test(
      `${scope}: update serializes ${action} across configs, profiles and state roots`,
      { timeout: 15000 },
      async () => {
        const { root, home, project } = await setup();
        const alias = join(root, 'alias');
        await symlink(
          scope === 'global' ? home : project,
          alias,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        const a = mutation(root, 'a', home, project, scope);
        let b: ReturnType<typeof mutation> | undefined;
        try {
          await a.wait('entered');
          b = mutation(
            root,
            'b',
            scope === 'global' ? alias : home,
            scope === 'global' ? project : alias,
            scope,
            action,
          );
          await b.wait('attempting');
          await new Promise((resolve) => setTimeout(resolve, 400));
          assert.equal(
            b.events.some((event) => event.kind === 'entered'),
            false,
            'Second installer entered while first mutation was held',
          );
          a.child.send('release');
          assert.equal((await a.wait('done')).result, 23);
          await b.wait('entered');
          b.child.send('release');
          assert.equal((await b.wait('done')).result, 23);
          assert.equal(
            (await readdir(scope === 'global' ? home : project)).includes(
              '.postplus-skills-update.lock',
            ),
            false,
          );
        } finally {
          await stop(a.child);
          if (b) await stop(b.child);
          await rm(root, { recursive: true, force: true });
        }
      },
    );
  }
}

for (const scope of ['global', 'current-directory']) {
  test(
    `${scope}: nonoverlapping scopes can mutate concurrently with shared config`,
    { timeout: 15000 },
    async () => {
      const { root, home, project } = await setup();
      const other = join(root, 'other');
      await mkdir(other);
      const a = mutation(root, 'shared', home, project, scope);
      const b = mutation(
        root,
        'shared',
        scope === 'global' ? other : home,
        scope === 'global' ? project : other,
        scope,
      );
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
}

for (const behavior of ['descendant', 'interrupt']) {
  test(
    `${behavior}: uncertain Skills installer keeps lock and prevents another mutation`,
    { timeout: 15000 },
    async () => {
      const { root, home, project } = await setup();
      const a = mutation(
        root,
        'a',
        home,
        project,
        'global',
        'update',
        behavior,
      );
      let b: ReturnType<typeof mutation> | undefined;
      let pid: number | undefined;
      try {
        await a.wait('entered');
        if (behavior === 'descendant') {
          pid = (await a.wait('descendant')).pid;
          await stop(a.child);
          process.kill(pid!, 0);
        } else {
          assert.match(
            (await a.wait('failed')).message!,
            /postplus_update_installation_uncertain/,
          );
          await stop(a.child);
        }
        b = mutation(root, 'b', home, project, 'global', 'uninstall');
        assert.match(
          (await b.wait('failed')).message!,
          /postplus_update_installation_uncertain/,
        );
        assert.equal(
          b.events.some((event) => event.kind === 'entered'),
          false,
        );
        assert.equal(
          (await readdir(join(home, '.postplus-skills-update.lock'))).length,
          1,
        );
      } finally {
        await stop(a.child);
        if (b) await stop(b.child);
        if (pid) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
