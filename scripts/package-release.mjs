#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const distDir = resolve(repoRoot, 'dist');
const packageJsonPath = resolve(repoRoot, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;
const versionedArchive = `postplus-cli-v${version}.tar.gz`;
const stableArchive = 'postplus-cli.tar.gz';
const packageRoot = resolve(distDir, 'package', 'postplus-cli');

function assertNoRuntimeDependencies() {
  const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  const populatedFields = dependencyFields.filter((field) => {
    const value = packageJson[field];
    return value && Object.keys(value).length > 0;
  });

  if (populatedFields.length > 0) {
    throw new Error(
      `Release packaging does not bundle runtime dependencies yet. Found ${populatedFields.join(
        ', ',
      )}; add a real bundling strategy before publishing.`,
    );
  }
}

function assertBuildExists() {
  const entry = resolve(repoRoot, 'build/index.js');

  if (!existsSync(entry)) {
    throw new Error('Missing build/index.js. Run pnpm build before pnpm release:package.');
  }
}

function assertNoTestFilesInBuild() {
  const buildDir = resolve(repoRoot, 'build');
  const forbidden = ['.test.js', '.test.mjs', '.spec.js', '.spec.mjs'];
  const found = [];

  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      const isDir = statSync(full).isDirectory();
      if (isDir) {
        walk(full);
      } else if (forbidden.some((suffix) => entry.endsWith(suffix))) {
        found.push(full.replace(repoRoot + '/', ''));
      }
    }
  }

  walk(buildDir);

  if (found.length > 0) {
    throw new Error(
      `Release build contains test files that must not ship:\n${found.map((f) => `  ${f}`).join('\n')}\n` +
        'Check tsconfig.json to exclude test files from the build output.',
    );
  }
}

function copyReleaseFiles() {
  rmSync(distDir, { force: true, recursive: true });
  mkdirSync(packageRoot, { recursive: true });

  cpSync(resolve(repoRoot, 'build'), resolve(packageRoot, 'build'), {
    recursive: true,
  });

  for (const fileName of ['package.json', 'README.md', 'LICENSE']) {
    cpSync(resolve(repoRoot, fileName), resolve(packageRoot, fileName));
  }

  mkdirSync(resolve(packageRoot, 'scripts'), { recursive: true });
  cpSync(resolve(repoRoot, 'scripts/install.sh'), resolve(packageRoot, 'scripts/install.sh'));
  cpSync(resolve(repoRoot, 'scripts/install.ps1'), resolve(packageRoot, 'scripts/install.ps1'));
  writeFileSync(resolve(packageRoot, 'VERSION'), `${version}\n`);
}

function createArchive() {
  execFileSync('tar', ['-czf', resolve(distDir, versionedArchive), '-C', resolve(distDir, 'package'), 'postplus-cli'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  cpSync(resolve(distDir, versionedArchive), resolve(distDir, stableArchive));
}

function writeSha256(fileName) {
  const filePath = resolve(distDir, fileName);
  const hash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
  writeFileSync(resolve(distDir, `${fileName}.sha256`), `${hash}  ${fileName}\n`);
}

assertNoRuntimeDependencies();
assertBuildExists();
assertNoTestFilesInBuild();
copyReleaseFiles();
createArchive();
writeSha256(versionedArchive);
writeSha256(stableArchive);

process.stdout.write(`Packaged ${versionedArchive} and ${stableArchive}\n`);
