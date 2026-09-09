import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'postplus-package-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const manifest = JSON.parse(
  readFileSync(join(repoRoot, 'package.json'), 'utf8'),
);
const releaseFiles = manifest.files;
const archive = join(
  repoRoot,
  'dist',
  `postplus-cli-v${manifest.version}.tar.gz`,
);
const extracted = join(scratch, 'extracted');
mkdirSync(extracted);
execFileSync('tar', ['-xzf', archive, '-C', extracted]);
const packageRoot = join(extracted, 'postplus-cli');
function filesUnder(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    return entry.isDirectory()
      ? filesUnder(join(directory, entry.name), relative + '/')
      : [relative];
  });
}
function script(root, name) {
  return spawnSync(process.execPath, [join(root, 'scripts', name)], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('actual release archive contains exactly the declared files and install envelope', () => {
  const archiveEntries = execFileSync('tar', ['-tzf', archive], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  assert.equal(
    archiveEntries.some((name) =>
      name.split('/').some((part) => part.startsWith('._')),
    ),
    false,
    'tar must not contain macOS metadata outside the release manifest',
  );
  const expected = [
    ...releaseFiles,
    'package.json',
    'scripts/install.sh',
    'scripts/install.ps1',
    'VERSION',
  ].sort();
  assert.deepEqual(filesUnder(packageRoot).filter((name) => !name.startsWith('node_modules/')).sort(), expected);
  const declarations = filesUnder(packageRoot).filter((name) =>
    !name.startsWith('node_modules/') && name.endsWith('.d.ts'),
  );
  assert.deepEqual(
    declarations.sort(),
    releaseFiles.filter((name) => name.endsWith('.d.ts')).sort(),
  );
  assert.equal(existsSync(join(packageRoot, 'src')), false);
  const packages = filesUnder(join(packageRoot, 'node_modules'))
    .filter((name) => name.endsWith('/package.json'))
    .map((name) => {
      const location = join(packageRoot, 'node_modules', name);
      const pkg = JSON.parse(readFileSync(location, 'utf8'));
      assert.ok(readdirSync(dirname(location)).some((file) => /^licen[cs]e(?:\.|$)/i.test(file)), `${pkg.name} license retained`);
      return `${pkg.name}@${pkg.version}`;
    });
  assert.deepEqual(packages.sort(), [
    'cross-spawn@7.0.6', 'isexe@2.0.0', 'path-key@3.1.1',
    'shebang-command@2.0.0', 'shebang-regex@3.0.0', 'which@2.0.2',
  ]);
  assert.equal(
    readFileSync(join(packageRoot, 'NOTICE'), 'utf8'),
    readFileSync(join(repoRoot, 'NOTICE'), 'utf8'),
  );
});

test('finalize removes only unpublished declarations; package rejects missing declarations and unexpected JS', () => {
  const fixture = join(scratch, 'fixture');
  mkdirSync(fixture);
  for (const item of [
    'build',
    'scripts',
    'package.json',
    'README.md',
    'LICENSE',
    'NOTICE',
  ]) {
    cpSync(join(repoRoot, item), join(fixture, item), { recursive: true });
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  writeFileSync(join(fixture, 'build', 'private-module.d.ts'), 'export {};');
  assert.equal(script(fixture, 'finalize-build.mjs').status, 0);
  assert.equal(
    existsSync(join(fixture, 'build', 'private-module.d.ts')),
    false,
  );
  assert.equal(script(fixture, 'package-release.mjs').status, 0);
  const declaration = join(fixture, 'build', 'hosted-lib.d.ts');
  const contents = readFileSync(declaration);
  rmSync(declaration);
  const missing = script(fixture, 'package-release.mjs');
  assert.notEqual(missing.status, 0);
  assert.match(
    missing.stderr,
    /Missing release build files[\s\S]*hosted-lib\.d\.ts/,
  );
  writeFileSync(declaration, contents);
  writeFileSync(join(fixture, 'build', 'unexpected.js'), 'export {};');
  assert.equal(script(fixture, 'finalize-build.mjs').status, 0);
  const unexpected = script(fixture, 'package-release.mjs');
  assert.notEqual(unexpected.status, 0);
  assert.match(unexpected.stderr, /must not ship[\s\S]*unexpected\.js/);
  assert.equal(script(fixture, 'clean-build.mjs').status, 0);
  assert.equal(existsSync(join(fixture, 'build')), false);
});

test('unpacked CLI runs offline and exported hosted-lib declaration resolves for a real consumer', () => {
  const environment = {
    ...process.env, HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    POSTPLUS_CONFIG_DIR: join(scratch, 'config'),
  };
  const version = execFileSync(
    process.execPath,
    [
      '--import',
      'data:text/javascript,globalThis.fetch=()=>{throw new Error("Network forbidden")}',
      join(packageRoot, 'build', 'index.js'),
      '--version',
    ],
    { cwd: extracted, encoding: 'utf8', env: environment },
  );
  assert.equal(version.trim(), manifest.version);
  const help = execFileSync(process.execPath, [join(packageRoot, 'build', 'index.js'), 'help'], {
    cwd: extracted, encoding: 'utf8', env: environment,
  });
  assert.match(help, /PostPlus/);
  const consumer = join(scratch, 'consumer');
  mkdirSync(join(consumer, 'node_modules', '@postplus'), { recursive: true });
  symlinkSync(
    packageRoot,
    join(consumer, 'node_modules', '@postplus', 'cli'),
    'dir',
  );
  writeFileSync(
    join(consumer, 'use.mts'),
    `import {runHostedRequest} from '@postplus/cli/hosted-lib';
const input: Parameters<typeof runHostedRequest>[0] = {domain: 'media', args: [], auth: {apiBaseUrl: 'https://example.invalid', cliSessionToken: 'test'}};
const result: Promise<unknown> = runHostedRequest(input);
`,
  );
  const types = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--skipLibCheck',
      'false',
      '--typeRoots',
      join(repoRoot, 'node_modules', '@types'),
      join(consumer, 'use.mts'),
    ],
    { cwd: consumer, encoding: 'utf8' },
  );
  assert.equal(types.status, 0, types.stdout + types.stderr);
});

test('npm archive installs offline into an isolated prefix and runs without workspace dependencies', () => {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', scratch], {
    cwd: repoRoot, encoding: 'utf8',
  }))[0];
  const prefix = join(scratch, 'npm-prefix');
  const env = {
    ...process.env, HOME: join(scratch, 'npm-home'), USERPROFILE: join(scratch, 'npm-home'),
    POSTPLUS_CONFIG_DIR: join(scratch, 'npm-config'),
    npm_config_cache: process.env.npm_config_cache ?? join(homedir(), '.npm'),
  };
  execFileSync('npm', ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(scratch, packed.filename)], {
    cwd: scratch, encoding: 'utf8', env,
  });
  const entry = join(prefix, 'node_modules', '@postplus', 'cli', 'build', 'index.js');
  const version = execFileSync(process.execPath, [entry, '--version'], { cwd: prefix, env, encoding: 'utf8' });
  assert.equal(version.trim(), manifest.version);
  const help = execFileSync(process.execPath, [entry, 'help'], { cwd: prefix, env, encoding: 'utf8' });
  assert.match(help, /PostPlus/);
});

test('unpacked CLI rejects unsupported Node before command or network work', () => {
  for (const version of ['20.10.0', '22.21.0', '24.4.9']) {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'data:text/javascript,' +
          encodeURIComponent(
            `Object.defineProperty(process.versions, 'node', {value: '${version}'}); globalThis.fetch=()=>{throw new Error('Network forbidden')}`,
          ),
        join(packageRoot, 'build', 'index.js'),
        '--version',
      ],
      { cwd: extracted, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires Node.js >=24\.5\.0/);
    assert.match(result.stderr, /Upgrade Node.js/);
    assert.equal(result.stdout, '');
  }
});
