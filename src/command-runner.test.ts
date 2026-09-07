import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CommandInterruptedError,
  runCommand,
  runInteractiveCommand,
} from './command-runner.js';

test('interactive runner preserves signal termination as a typed interruption', async () => {
  await assert.rejects(
    runInteractiveCommand(process.execPath, [
      '-e',
      'process.kill(process.pid, "SIGTERM")',
    ]),
    (error: unknown) =>
      error instanceof CommandInterruptedError && error.signal === 'SIGTERM',
  );
});

const literalArgs = [
  '',
  'two words',
  'a"quoted"value',
  'trailing\\',
  'quote\\"tail\\',
  '& echo SHOULD_NOT_EXECUTE',
  '| more > output < input',
  '%PATH%',
  '!PATH!',
  '^()[];,=*?',
  '中文路径',
];

test('native command receives literal arguments without shell interpretation', async () => {
  const result = await runCommand(process.execPath, [
    '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
    '--',
    ...literalArgs,
  ]);
  assert.deepEqual(JSON.parse(result.stdout), literalArgs);
  assert.equal(result.stderr, '');
});

test('captured runner drains stderr and includes the failing exit code', async () => {
  const tail = 'END-OF-STDERR';
  await assert.rejects(
    runCommand(process.execPath, [
      '-e',
      `process.stderr.write('x'.repeat(128 * 1024) + '${tail}', () => process.exit(7))`,
    ]),
    (error: Error) =>
      error.message.startsWith('Command failed (7):') &&
      error.message.endsWith(tail),
  );
});

test('captured runner preserves spawn failures and timeout', async () => {
  await assert.rejects(
    runCommand('postplus-deliberately-missing-executable', []),
    {
      code: 'ENOENT',
    },
  );
  await assert.rejects(
    runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 200,
    }),
    /Command timed out:/,
  );
});

test('interactive native runner preserves env, literal arguments, and exit code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postplus-runner-test-'));
  try {
    const output = join(root, 'result.json');
    const code = await runInteractiveCommand(
      process.execPath,
      [
        '-e',
        'require("node:fs").writeFileSync(process.env.POSTPLUS_TEST_OUTPUT, JSON.stringify(process.argv.slice(1))); process.exit(9)',
        '--',
        ...literalArgs,
      ],
      { env: { ...process.env, POSTPLUS_TEST_OUTPUT: output } },
    );
    assert.equal(code, 9);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), literalArgs);
    await assert.rejects(
      runInteractiveCommand('postplus-deliberately-missing-executable', []),
      {
        code: 'ENOENT',
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// These are intentionally skipped off Windows: replacing process.platform on
// macOS cannot prove cmd.exe quoting, PATH resolution, or Windows pipe behavior.
test(
  'Windows installed npm and npx start without a shell:true workaround',
  {
    skip: process.platform !== 'win32',
  },
  async () => {
    for (const command of ['npm', 'npx']) {
      const result = await runCommand(command, ['--version']);
      assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
      assert.equal(await runInteractiveCommand(command, ['--version']), 0);
    }
  },
);

test(
  'Windows npm/npx/postplus shims preserve quotes, metacharacters, space paths, and custom PATH',
  {
    skip: process.platform !== 'win32',
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'postplus runner & test-'));
    try {
      const script = join(root, 'argv.cjs');
      const output = join(root, 'argv.json');
      await writeFile(
        script,
        [
          'const json = JSON.stringify(process.argv.slice(2));',
          'if (process.env.POSTPLUS_TEST_OUTPUT) require("node:fs").writeFileSync(process.env.POSTPLUS_TEST_OUTPUT, json);',
          'else process.stdout.write(json);',
          'process.stderr.write("shim stderr");',
          'process.exitCode = Number(process.env.POSTPLUS_TEST_EXIT || 0);',
        ].join('\n'),
      );

      // Cover global-style shims and npm-generated local .bin shims, which need
      // different escaping depths. No npm install, network, or daily config writes.
      for (const bin of [root, join(root, 'node_modules', '.bin')]) {
        await mkdir(bin, { recursive: true });
        for (const name of ['npm', 'npx', 'postplus']) {
          const shim = join(bin, `${name}.cmd`);
          await writeFile(
            shim,
            `@ECHO OFF\r\n"${process.execPath}" "${script}" %*\r\n`,
          );
          const result = await runCommand(shim, literalArgs);
          assert.deepEqual(JSON.parse(result.stdout), literalArgs);
          assert.equal(result.stderr, 'shim stderr');

          const env = Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => key.toUpperCase() !== 'PATH',
            ),
          );
          Object.assign(env, {
            Path: bin,
            POSTPLUS_TEST_OUTPUT: output,
            POSTPLUS_TEST_EXIT: '17',
          });

          assert.equal(
            await runInteractiveCommand(name, literalArgs, { env }),
            17,
          );
          assert.deepEqual(
            JSON.parse(await readFile(output, 'utf8')),
            literalArgs,
          );
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
