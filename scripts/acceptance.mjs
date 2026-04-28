#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSkillsRepo = path.resolve(repoRoot, '..', '..', '..', 'postplus-skills');
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

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed (${code ?? 'unknown'}): ${command} ${args.join(' ')}`));
    });
    child.on('error', reject);
  });
}

await assertPathExists(
  path.resolve(skillsRepoRoot, 'skills', 'INDEX.md'),
  `PostPlus skills checkout is missing skills/INDEX.md: ${skillsRepoRoot}`,
);

await run('npx', ['-y', 'skills', 'add', skillsRepoRoot, '--list']);

process.stdout.write('PostPlus CLI acceptance passed.\n');
