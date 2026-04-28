#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

rmSync(resolve(repoRoot, 'build'), { force: true, recursive: true });
