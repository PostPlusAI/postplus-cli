#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const defaultSkillsRepo = path.resolve(
  repoRoot,
  '..',
  '..',
  '..',
  'postplus-skills',
);
const skillsRepoRoot = process.env.POSTPLUS_SKILLS_REPO_DIR?.trim()
  ? path.resolve(process.env.POSTPLUS_SKILLS_REPO_DIR.trim())
  : defaultSkillsRepo;

async function assertPathExists(targetPath, message) {
  try {
    await access(targetPath);
  } catch {
    throw new Error(message);
  }
}

async function assertPathMissing(targetPath, message) {
  try {
    await access(targetPath);
  } catch {
    return;
  }
  throw new Error(message);
}

function createIsolatedNpxEnv(tempRoot) {
  const tempNpmPrefix = path.join(tempRoot, 'npm-prefix');

  return {
    HOME: path.join(tempRoot, 'home'),
    INIT_CWD: repoRoot,
    LOGNAME: process.env.LOGNAME,
    NO_PROXY: process.env.NO_PROXY,
    PATH: process.env.PATH,
    SHELL: process.env.SHELL,
    TMPDIR: process.env.TMPDIR,
    USER: process.env.USER,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    no_proxy: process.env.no_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    npm_config_update_notifier: 'false',
    npm_config_cache: path.join(tempRoot, 'npm-cache'),
    npm_config_prefix: tempNpmPrefix,
  };
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: options.env ?? process.env,
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Command failed (${code ?? 'unknown'}): ${command} ${args.join(' ')}`,
        ),
      );
    });
    child.on('error', reject);
  });
}

await assertPathExists(
  path.resolve(skillsRepoRoot, 'skills', 'catalog.json'),
  `PostPlus skills checkout is missing skills/catalog.json: ${skillsRepoRoot}`,
);
await assertPathMissing(
  path.resolve(skillsRepoRoot, 'skills', 'INDEX.md'),
  `PostPlus skills checkout must not publish skills/INDEX.md: ${skillsRepoRoot}`,
);
await assertPathExists(
  path.resolve(repoRoot, 'build', 'index.js'),
  'PostPlus CLI build is missing build/index.js. Run pnpm build before acceptance.',
);
try {
  await access(path.resolve(repoRoot, 'build', 'index.js'), constants.X_OK);
} catch {
  throw new Error(
    'PostPlus CLI build/index.js must be executable because package.json exposes it as the postplus bin.',
  );
}

const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), 'postplus-cli-acceptance-'),
);

try {
  await mkdir(path.join(tempRoot, 'home'), { recursive: true });
  await mkdir(path.join(tempRoot, 'npm-cache'), { recursive: true });
  await mkdir(path.join(tempRoot, 'npm-prefix', 'lib'), { recursive: true });
  await run(
    'npx',
    ['-y', 'skills', 'add', skillsRepoRoot, '--list', '--full-depth'],
    {
      env: createIsolatedNpxEnv(tempRoot),
    },
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

process.stdout.write('PostPlus CLI acceptance passed.\n');
