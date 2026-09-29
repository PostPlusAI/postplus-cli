import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { registerCommandPath } from './path-registration.mjs';
const exec = promisify(execFile);

test('PATH registration preserves user settings and is repeatable with spaces and shell metacharacters', { skip: process.platform === 'win32' }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'postplus-path-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "program ' $HOME `false`");
  const original = 'export USER_SETTING=preserved';
  await writeFile(join(home, '.profile'), original);
  await registerCommandPath(root, { home });
  const once = await readFile(join(home, '.profile'), 'utf8');
  await registerCommandPath(root, { home });
  assert.equal(await readFile(join(home, '.profile'), 'utf8'), once);
  assert.ok(once.startsWith(original + '\n'));
  const result = await exec('/bin/sh', ['-c', '. "$HOME/.profile"; printf "%s\\n%s" "$USER_SETTING" "$PATH"'], { env: { HOME: home, PATH: '/usr/bin:/bin' } });
  assert.equal(result.stdout, `preserved\n${join(root, 'bin')}:/usr/bin:/bin`);
});

test('Windows registration writes only the user PATH and passes paths as data', async () => {
  const root = "C:\\Users\\Test User\\PostPlus";
  let called = false;
  await registerCommandPath(root, { platform: 'win32', run: async (command, args, options) => {
    called = true;
    assert.equal(command, 'powershell.exe');
    assert.ok(args.at(-1).includes("GetEnvironmentVariable('Path','User')"));
    assert.ok(args.at(-1).includes("'User')"));
    assert.ok(!args.at(-1).includes(root));
    assert.equal(options.env.POSTPLUS_REGISTER_BIN, join(root, 'bin'));
  } });
  assert.equal(called, true);
});
