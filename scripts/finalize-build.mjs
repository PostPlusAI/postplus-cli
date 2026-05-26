#!/usr/bin/env node
import { chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

chmodSync(resolve(repoRoot, 'build', 'index.js'), 0o755);
