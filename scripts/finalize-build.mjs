#!/usr/bin/env node
import { chmodSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

// TypeScript emits declarations for every module. Only the explicitly published
// declarations belong in the release build; package.json.files owns that surface.
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
);
const releaseFiles = new Set(packageJson.files);
function removePrivateDeclarations(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = resolve(directory, entry.name);
    if (entry.isDirectory()) removePrivateDeclarations(filePath);
    else if (
      entry.name.endsWith('.d.ts') &&
      !releaseFiles.has(relative(repoRoot, filePath).replaceAll('\\', '/'))
    ) {
      rmSync(filePath);
    }
  }
}
removePrivateDeclarations(resolve(repoRoot, 'build'));
chmodSync(resolve(repoRoot, 'build', 'index.js'), 0o755);
