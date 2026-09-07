import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import test, { type TestContext } from 'node:test';

import { runCommand, runInteractiveCommand } from './command-runner.js';
import {
  generateUpdateStatusReport,
  resolveCliUpdateInstallation,
  runCliSelfUpdateIfOutdated,
} from './update-check.js';

// Real npm, private config/cache/prefix, and loopback registries. These checks
// exercise npm's actual global/scoped configuration resolution, not fetch mocks.
async function npmRegistryFixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'postplus-npm-source-')),
  );
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^npm_config_/iu.test(key) || /^(https?|all)_proxy$/iu.test(key))
      delete environment[key];
  }
  Object.assign(environment, {
    POSTPLUS_CONFIG_DIR: join(root, 'postplus'),
    npm_config_userconfig: join(root, 'user.npmrc'),
    npm_config_globalconfig: join(root, 'global.npmrc'),
    npm_config_prefix: join(root, 'prefix'),
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_fetch_retries: '0',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  });
  await writeFile(environment.npm_config_globalconfig!, '');
  await writeFile(environment.npm_config_userconfig!, '');
  const previousConfig = process.env.POSTPLUS_CONFIG_DIR;
  process.env.POSTPLUS_CONFIG_DIR = environment.POSTPLUS_CONFIG_DIR;
  const servers: Server[] = [];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (previousConfig === undefined) delete process.env.POSTPLUS_CONFIG_DIR;
    else process.env.POSTPLUS_CONFIG_DIR = previousConfig;
    await rm(root, { recursive: true, force: true });
  });
  const registry = async (version: string) => {
    const state = {
      version,
      requests: [] as string[],
      status: 200,
      hang: false,
      tarballs: new Map<string, Buffer>(),
    };
    const server = createServer((request, response) => {
      state.requests.push(request.url!);
      if (state.hang) return;
      if (state.status !== 200) {
        response.writeHead(state.status);
        response.end('{}');
        return;
      }
      const archive = state.tarballs.get(request.url!);
      if (archive) {
        response.end(archive);
        return;
      }
      response.setHeader('content-type', 'application/json');
      const versions = new Set([
        state.version,
        ...[...state.tarballs.keys()].map((p) => p.slice(1, -4)),
      ]);
      response.end(
        JSON.stringify({
          name: '@postplus/cli',
          'dist-tags': { latest: state.version },
          versions: Object.fromEntries(
            [...versions].map((v) => [
              v,
              {
                name: '@postplus/cli',
                version: v,
                dist: { tarball: `${url}/${v}.tgz` },
              },
            ]),
          ),
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    return { url, state };
  };
  const configure = async (defaultUrl: string, scopedUrl?: string) => {
    await writeFile(
      environment.npm_config_userconfig!,
      `registry=${defaultUrl}\n${scopedUrl ? `@postplus:registry=${scopedUrl}\n` : ''}`,
    );
  };
  const status = (force = false) =>
    generateUpdateStatusReport(
      { force },
      {
        environment,
        fetchFn: async () =>
          Response.json({
            schemaVersion: 2,
            releaseId: 'fixture-release',
            source: 'PostPlusAI/postplus-skills',
            skills: [
              {
                name: 'fixture-skill',
                path: 'skills/fixture-skill/SKILL.md',
                status: 'released',
              },
            ],
          }),
      },
    );
  return { root, environment, registry, configure, status };
}

test('real npm status uses scoped registry precedence and invalidates cache when the effective source changes', async (t) => {
  const f = await npmRegistryFixture(t);
  const first = await f.registry('999.1.0');
  const scoped = await f.registry('999.2.0');
  await f.configure(first.url);
  assert.equal((await f.status()).cli.latestVersion, '999.1.0');
  const requests = first.state.requests.length;
  assert.equal((await f.status()).source, 'cache');
  assert.equal(first.state.requests.length, requests);
  await f.configure(first.url, scoped.url);
  const switched = await f.status();
  assert.equal(switched.source, 'remote');
  assert.equal(switched.cli.latestVersion, '999.2.0');
  assert.equal(
    first.state.requests.length,
    requests,
    'scoped registry overrides default',
  );
  await f.configure('http://127.0.0.1:1', scoped.url);
  assert.equal(
    (await f.status()).source,
    'cache',
    'irrelevant default change preserves effective scoped source',
  );
  await f.configure(first.url);
  first.state.status = 503;
  const failedSwitch = await f.status();
  assert.equal(failedSwitch.source, 'unavailable');
  assert.equal(
    failedSwitch.cli.latestVersion,
    null,
    'must not reuse another registry cache on failure',
  );
  const cache = await readFile(
    join(f.environment.POSTPLUS_CONFIG_DIR!, 'update-check.json'),
    'utf8',
  );
  assert.ok(
    !cache.includes(first.url) && !cache.includes(scoped.url),
    'cache stores only source hash',
  );
});

test('legacy caches and failed npm config queries never return cached update claims', async (t) => {
  const f = await npmRegistryFixture(t);
  await mkdir(f.environment.POSTPLUS_CONFIG_DIR!, { recursive: true });
  await writeFile(
    join(f.environment.POSTPLUS_CONFIG_DIR!, 'update-check.json'),
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      cli: { currentVersion: '0.2.8', latestVersion: '999.0.0' },
      skills: { latestReleaseId: 'old-source' },
    }),
  );
  await f.configure('http://127.0.0.1:1');
  assert.equal((await f.status()).source, 'unavailable');
  const registry = await f.registry('999.0.0');
  await f.configure(registry.url);
  assert.equal((await f.status()).source, 'remote');
  const report = await generateUpdateStatusReport(
    {},
    {
      environment: f.environment,
      fetchFn: async () => {
        assert.fail('config failure must not fetch');
      },
      runCommand: async () => {
        throw new Error('private://secret-token');
      },
    },
  );
  assert.equal(report.source, 'unavailable');
  assert.ok(!JSON.stringify(report).includes('secret-token'));
});

test('real npm global view ignores project npmrc and pins install if latest moves', async (t) => {
  const f = await npmRegistryFixture(t);
  const registry = await f.registry('0.2.8');
  const projectRegistry = await f.registry('999.9.9');
  await f.configure(registry.url);
  for (const version of ['0.2.8', '999.0.0', '999.0.1']) {
    const pkg = join(f.root, `package-${version}`);
    await mkdir(join(pkg, 'build'), { recursive: true });
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: '@postplus/cli',
        version,
        bin: { postplus: 'build/index.js' },
      }),
    );
    await writeFile(
      join(pkg, 'build/index.js'),
      `#!/usr/bin/env node\nif (process.env.POSTPLUS_CLI_UPDATE_CONTINUATION_VERSION !== ${JSON.stringify(version)}) process.exit(19);\n`,
    );
    await runCommand(
      'npm',
      ['pack', pkg, '--pack-destination', pkg, '--json'],
      { env: f.environment },
    );
    const archive = (await readdir(pkg)).find((p) => p.endsWith('.tgz'))!;
    registry.state.tarballs.set(
      `/${version}.tgz`,
      await readFile(join(pkg, archive)),
    );
  }
  await runCommand('npm', ['install', '-g', '@postplus/cli@0.2.8'], {
    env: f.environment,
  });
  const npmRoot = (
    await runCommand('npm', ['root', '-g'], { env: f.environment })
  ).stdout.trim();
  registry.state.version = '999.0.0';
  const project = join(f.root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'package.json'), '{"private":true}');
  await writeFile(
    join(project, '.npmrc'),
    `registry=${projectRegistry.url}\n@postplus:registry=${projectRegistry.url}\n`,
  );
  const previousCwd = process.cwd();
  let installArgs: string[] | undefined;
  try {
    process.chdir(project);
    const result = await runCliSelfUpdateIfOutdated({
      environment: f.environment,
      currentCliEntryPath: join(npmRoot, '@postplus/cli/build/index.js'),
      runCommand: async (command, args, options) => {
        const result = await runCommand(command, args, options);
        if (args[0] === 'view') registry.state.version = '999.0.1';
        return result;
      },
      runInteractiveCommand: async (command, args, options) => {
        if (command === 'npm') installArgs = args;
        return runInteractiveCommand(command, args, options);
      },
      writeOutput: () => {},
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.latestVersion, '999.0.0');
  } finally {
    process.chdir(previousCwd);
  }
  assert.deepEqual(installArgs, ['install', '-g', '@postplus/cli@999.0.0']);
  assert.equal(
    JSON.parse(
      await readFile(join(npmRoot, '@postplus/cli/package.json'), 'utf8'),
    ).version,
    '999.0.0',
  );
  assert.deepEqual(
    projectRegistry.state.requests,
    [],
    'global mode ignores project npmrc for view and install',
  );
});

test('invalid npm JSON/version and npm failures stop before installation', async () => {
  for (const stdout of [
    'not json',
    '{}',
    '[]',
    '"latest"',
    '"1.0.0 --prefix=/other"',
    '""',
  ]) {
    await assert.rejects(
      runCliSelfUpdateIfOutdated({
        runCommand: async () => ({ stdout, stderr: '' }),
        runInteractiveCommand: async () => {
          assert.fail('invalid metadata must not install');
        },
      }),
      /invalid PostPlus CLI version/,
    );
  }
  await assert.rejects(
    runCliSelfUpdateIfOutdated({
      runCommand: async () => {
        throw new Error('failure with secret-token');
      },
      runInteractiveCommand: async () => {
        assert.fail('npm query failure must not install');
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      /Failed to check/.test(error.message) &&
      !error.message.includes('secret-token'),
  );
});

test(
  'real npm nonzero and version query timeout never invoke the installer',
  { timeout: 25000 },
  async (t) => {
    const f = await npmRegistryFixture(t);
    const registry = await f.registry('999.0.0');
    await f.configure(registry.url);
    for (const hang of [false, true]) {
      registry.state.status = 503;
      registry.state.hang = hang;
      await assert.rejects(
        runCliSelfUpdateIfOutdated({
          environment: f.environment,
          runInteractiveCommand: async () => {
            assert.fail('failed version query must not install');
          },
        }),
        /Failed to check latest PostPlus CLI version/,
      );
    }
  },
);

test(
  'concurrent outdated callers keep continuation stable and install only once',
  { timeout: 15000 },
  async (t) => {
    const value = await fixture(t);
    let installed = 0;
    let continued = 0;
    let entered!: () => void;
    let release!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dependencies = {
      currentCliEntryPath: value.cliEntryPath,
      environment: { POSTPLUS_CONFIG_DIR: join(value.root, 'config') },
      runCommand: async (_command: string, args: string[]) => ({
        stdout: args[0] === 'view' ? '"999.0.0"' : value.installationRoot,
        stderr: '',
      }),
      runInteractiveCommand: async (command: string) => {
        if (command === 'npm') {
          installed += 1;
          await writeFile(
            join(value.installationRoot, '@postplus/cli/package.json'),
            JSON.stringify({ version: '999.0.0' }),
          );
        } else {
          continued += 1;
          if (continued === 1) {
            entered();
            await gate;
          }
        }
        return 0;
      },
      writeOutput: () => {},
    };
    const first = runCliSelfUpdateIfOutdated(dependencies);
    await firstEntered;
    const second = runCliSelfUpdateIfOutdated(dependencies);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(installed, 1);
      assert.equal(
        continued,
        1,
        'second caller must wait until the first continuation finishes',
      );
    } finally {
      release();
    }
    const results = await Promise.all([first, second]);
    assert.ok(results.every((result) => result.exitCode === 0));
    assert.equal(
      installed,
      1,
      'waiting caller must recheck installed package under lock',
    );
    assert.equal(continued, 2);
  },
);

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'postplus-install-target-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const installationRoot = join(root, 'prefix with spaces', 'node_modules');
  const cliEntryPath = join(
    installationRoot,
    '@postplus',
    'cli',
    'build',
    'index.js',
  );
  await mkdir(dirname(cliEntryPath), { recursive: true });
  await writeFile(cliEntryPath, '// non-executable test fixture\n');
  await writeFile(
    join(installationRoot, '@postplus/cli/package.json'),
    JSON.stringify({ version: '0.0.0' }),
  );
  return { root, installationRoot, cliEntryPath };
}

test('queries npm with the same environment and canonicalizes the root', async (t) => {
  const value = await fixture(t);
  const alias = join(value.root, 'global alias');
  await symlink(
    value.installationRoot,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const environment = {
    npm_config_prefix: dirname(value.installationRoot),
    POSTPLUS_CONFIG_DIR: join(value.root, 'config-a'),
  };
  const result = await resolveCliUpdateInstallation({
    currentCliEntryPath: value.cliEntryPath,
    environment,
    runCommand: async (command, args, options) => {
      assert.equal(command, 'npm');
      assert.deepEqual(args, ['root', '-g']);
      assert.equal(options?.env, environment);
      return { stdout: `${alias}\n`, stderr: '' };
    },
  });
  assert.deepEqual(result, {
    installationRoot: value.installationRoot,
    cliEntryPath: value.cliEntryPath,
  });
});

test(
  'accepts a normal global bin symlink to the selected package entry',
  { skip: process.platform === 'win32' },
  async (t) => {
    const value = await fixture(t);
    const bin = join(value.root, 'postplus');
    await symlink(value.cliEntryPath, bin);
    const result = await resolveCliUpdateInstallation({
      currentCliEntryPath: bin,
      environment: {},
      runCommand: async () => ({ stdout: value.installationRoot, stderr: '' }),
    });
    assert.equal(result.cliEntryPath, value.cliEntryPath);
  },
);

test('rejects another prefix and sibling package names before any install', async (t) => {
  const value = await fixture(t);
  for (const entry of [
    join(value.root, 'other-prefix', 'index.js'),
    join(value.installationRoot, '@postplus', 'cli-other', 'index.js'),
  ]) {
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, '// fixture');
    let installCalled = false;
    await assert.rejects(
      runCliSelfUpdateIfOutdated({
        currentCliEntryPath: entry,
        environment: {},
        runCommand: async (_command, args) => ({
          stdout: args[0] === 'view' ? '"999.0.0"' : value.installationRoot,
          stderr: '',
        }),
        runInteractiveCommand: async () => {
          installCalled = true;
          return 0;
        },
        writeOutput: () => {},
      }),
      /does not belong to the selected npm global installation/,
    );
    assert.equal(installCalled, false);
  }
});

test('rejects package symlinks escaping the actual installation target', async (t) => {
  const value = await fixture(t);
  const otherRoot = join(value.root, 'linked-root');
  await mkdir(join(otherRoot, '@postplus'), { recursive: true });
  await symlink(
    dirname(dirname(value.cliEntryPath)),
    join(otherRoot, '@postplus', 'cli'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    resolveCliUpdateInstallation({
      currentCliEntryPath: join(
        otherRoot,
        '@postplus',
        'cli',
        'build',
        'index.js',
      ),
      environment: {},
      runCommand: async () => ({ stdout: otherRoot, stderr: '' }),
    }),
    /does not belong/,
  );
});

test('fails clearly on missing entry, missing target, invalid npm output, and npm errors', async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    resolveCliUpdateInstallation({
      currentCliEntryPath: undefined,
      environment: {},
      runCommand: async () => {
        assert.fail('must not query npm without entry');
      },
    }),
    /cannot determine the running CLI entry/,
  );
  for (const stdout of [
    '',
    'relative/node_modules',
    `${value.installationRoot}\nextra output`,
  ]) {
    await assert.rejects(
      resolveCliUpdateInstallation({
        currentCliEntryPath: value.cliEntryPath,
        environment: {},
        runCommand: async () => ({ stdout, stderr: '' }),
      }),
      /single absolute global installation directory/,
    );
  }
  for (const [entry, root] of [
    [join(value.root, 'missing.js'), value.installationRoot],
    [value.cliEntryPath, join(value.root, 'missing-root')],
    [dirname(value.cliEntryPath), value.installationRoot],
  ]) {
    await assert.rejects(
      resolveCliUpdateInstallation({
        currentCliEntryPath: entry,
        environment: {},
        runCommand: async () => ({ stdout: root!, stderr: '' }),
      }),
      /could not verify/,
    );
  }
  const npmError = new Error('npm query failed');
  await assert.rejects(
    resolveCliUpdateInstallation({
      currentCliEntryPath: value.cliEntryPath,
      environment: {},
      runCommand: async () => {
        throw npmError;
      },
    }),
    (error) => error === npmError,
  );
});

test('does not query an install target when no update is needed', async () => {
  const result = await runCliSelfUpdateIfOutdated({
    environment: {},
    runCommand: async (_command, args) => {
      assert.equal(
        args[0],
        'view',
        'only version lookup, no installation target lookup',
      );
      return { stdout: '"0.0.0"', stderr: '' };
    },
    runInteractiveCommand: async () => {
      assert.fail('no install for up-to-date CLI');
    },
    writeOutput: () => {},
  });
  assert.equal(result.updateAvailable, false);
});

test('uses the queried environment for installation and never continues a failed install', async (t) => {
  const value = await fixture(t);
  // Keep config paths isolated as well as the npm installation target.
  const previousConfigDir = process.env.POSTPLUS_CONFIG_DIR;
  const environment = {
    POSTPLUS_CONFIG_DIR: join(value.root, 'config'),
    npm_config_prefix: dirname(value.installationRoot),
  };
  process.env.POSTPLUS_CONFIG_DIR = environment.POSTPLUS_CONFIG_DIR;
  t.after(() => {
    if (previousConfigDir === undefined) delete process.env.POSTPLUS_CONFIG_DIR;
    else process.env.POSTPLUS_CONFIG_DIR = previousConfigDir;
  });
  let installCalls = 0;
  const result = await runCliSelfUpdateIfOutdated({
    currentCliEntryPath: value.cliEntryPath,
    environment,
    runCommand: async (_command, args, options) => {
      assert.equal(options?.env, environment);
      return {
        stdout: args[0] === 'view' ? '"999.0.0"' : value.installationRoot,
        stderr: '',
      };
    },
    runInteractiveCommand: async (command, args, options) => {
      installCalls += 1;
      assert.equal(command, 'npm');
      assert.deepEqual(args, ['install', '-g', '@postplus/cli@999.0.0']);
      assert.equal(options?.env, environment);
      return 11;
    },
    writeOutput: () => {},
  });
  assert.equal(installCalls, 1);
  assert.equal(result.exitCode, 11);
});
