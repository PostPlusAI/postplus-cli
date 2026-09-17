import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/skills-runtime');
const manifest = JSON.parse(await readFile(join(directory, 'integrity.json'), 'utf8'));
if (manifest.upstream !== 'skills@1.5.26') throw new Error('Unexpected skills runtime version.');
const actual = [];
async function check(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await check(join(dir, entry.name), `${name}/`);
    else if (name !== 'integrity.json') {
      actual.push(name);
      if (createHash('sha256').update(await readFile(join(dir, entry.name))).digest('hex') !== manifest.files[name]) throw new Error(`Vendored runtime integrity mismatch: ${name}`);
    }
  }
}
await check(directory);
if (actual.length !== Object.keys(manifest.files).length) throw new Error('Vendored runtime file missing.');
console.error(`Verified ${manifest.upstream}: ${actual.length} runtime/license files.`);
