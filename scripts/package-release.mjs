#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
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

function assertSupportedRuntimeDependencies() {
  // A's cross-platform command runner is the only runtime dependency. Media
  // acquisition continues to use Node's native HTTP/proxy support.
  if (JSON.stringify(packageJson.dependencies) !== JSON.stringify({ 'cross-spawn': '7.0.6' })) {
    throw new Error('Review release packaging before changing runtime dependencies.');
  }
  const dependencyFields = ['optionalDependencies', 'peerDependencies'];
  const populatedFields = dependencyFields.filter((field) => {
    const value = packageJson[field];
    return value && Object.keys(value).length > 0;
  });

  if (populatedFields.length > 0) {
    throw new Error(
      `Release packaging does not support ${populatedFields.join(
        ', ',
      )}; add a real bundling strategy before publishing.`,
    );
  }
}

function copyRuntimeDependencies() {
  const installedRoot = realpathSync(resolve(repoRoot, 'node_modules'));
  function copyDependency(name, fromManifest, targetParent, ancestors = []) {
    const manifestPath = realpathSync(createRequire(fromManifest).resolve(`${name}/package.json`));
    if (!manifestPath.startsWith(installedRoot + sep)) {
      throw new Error(`Dependency ${name} is outside this checkout's installed dependencies.`);
    }
    if (ancestors.includes(manifestPath)) throw new Error(`Cyclic runtime dependency: ${name}`);
    const metadata = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const source = dirname(manifestPath);
    const target = resolve(targetParent, 'node_modules', name);
    if (name === 'cross-spawn' && metadata.version !== packageJson.dependencies[name]) {
      throw new Error('Installed cross-spawn does not match the pinned runtime version.');
    }
    // Copy the actual local pnpm-resolved closure, including licenses. Nested
    // dependencies avoid flattening distinct versions or following global npm.
    cpSync(source, target, {
      recursive: true,
      filter: (entry) => basename(entry) !== 'node_modules',
    });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      copyDependency(dependency, manifestPath, target, [...ancestors, manifestPath]);
    }
    process.stdout.write(`Bundled ${name}@${metadata.version} (${relative(packageRoot, target)})\n`);
  }
  for (const name of Object.keys(packageJson.dependencies)) {
    copyDependency(name, packageJsonPath, packageRoot);
  }
}

function assertBuildExists() {
  const missingFiles = getReleaseBuildFiles().filter(
    (fileName) => !existsSync(resolve(repoRoot, fileName)),
  );

  if (missingFiles.length > 0) {
    throw new Error(
      [
        'Missing release build files. Run pnpm build before pnpm release:package.',
        ...missingFiles.map((fileName) => `  ${fileName}`),
      ].join('\n'),
    );
  }
}

function assertBuildOnlyContainsReleaseFiles() {
  const buildDir = resolve(repoRoot, 'build');
  const allowedFiles = new Set(getReleaseBuildFiles());
  const unexpected = [];

  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      const isDir = statSync(full).isDirectory();
      if (isDir) {
        walk(full);
      } else {
        const relativePath = full.replace(repoRoot + '/', '');
        if (!allowedFiles.has(relativePath)) {
          unexpected.push(relativePath);
        }
      }
    }
  }

  walk(buildDir);

  if (unexpected.length > 0) {
    throw new Error(
      [
        'Release build contains files that must not ship:',
        ...unexpected.map((fileName) => `  ${fileName}`),
        'Run pnpm build to regenerate from the current source tree.',
      ].join('\n'),
    );
  }
}

function copyReleaseFiles() {
  rmSync(distDir, { force: true, recursive: true });
  mkdirSync(packageRoot, { recursive: true });

  for (const fileName of getReleaseBuildFiles()) {
    const targetPath = resolve(packageRoot, fileName);
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(resolve(repoRoot, fileName), targetPath);
  }

  for (const fileName of ['package.json', ...packageJson.files.filter((name) => !name.startsWith('build/'))]) {
    cpSync(resolve(repoRoot, fileName), resolve(packageRoot, fileName));
  }

  mkdirSync(resolve(packageRoot, 'scripts'), { recursive: true });
  cpSync(resolve(repoRoot, 'scripts/install.sh'), resolve(packageRoot, 'scripts/install.sh'));
  cpSync(resolve(repoRoot, 'scripts/install.ps1'), resolve(packageRoot, 'scripts/install.ps1'));
  writeFileSync(resolve(packageRoot, 'VERSION'), `${version}\n`);
}

function getReleaseBuildFiles() {
  return packageJson.files.filter(
    (fileName) => fileName.startsWith('build/'),
  );
}

function createArchive() {
  execFileSync('tar', ['-czf', resolve(distDir, versionedArchive), '-C', resolve(distDir, 'package'), 'postplus-cli'], {
    cwd: repoRoot,
    // macOS tar must not add AppleDouble files outside package.json.files.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: 'inherit',
  });

  cpSync(resolve(distDir, versionedArchive), resolve(distDir, stableArchive));
}

function writeSha256(fileName) {
  const filePath = resolve(distDir, fileName);
  const hash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
  writeFileSync(resolve(distDir, `${fileName}.sha256`), `${hash}  ${fileName}\n`);
}

assertSupportedRuntimeDependencies();
assertBuildExists();
assertBuildOnlyContainsReleaseFiles();
copyReleaseFiles();
copyRuntimeDependencies();
createArchive();
writeSha256(versionedArchive);
writeSha256(stableArchive);

process.stdout.write(`Packaged ${versionedArchive} and ${stableArchive}\n`);
