import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'vendor-source/skills');
const output = join(root, 'vendor/skills-runtime');
const manifest = JSON.parse(await readFile(join(source, 'sources.json'), 'utf8'));
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
if (`esbuild@${esbuild.version}` !== manifest.builder) throw new Error('Pinned esbuild version mismatch.');
const temp = await mkdtemp(join(root, '.skills-runtime-build-'));
try {
  for (const pkg of manifest.packages) {
    const archive = join(source, pkg.archive);
    const bytes = await readFile(archive);
    if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== pkg.integrity) throw new Error(`Upstream integrity mismatch: ${pkg.name}`);
    const dest = join(temp, 'node_modules', pkg.name);
    await mkdir(dest, { recursive: true });
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', dest]);
    const metadata = JSON.parse(await readFile(join(dest, 'package.json'), 'utf8'));
    if (metadata.name !== pkg.name || metadata.version !== pkg.version) throw new Error(`Upstream identity mismatch: ${pkg.name}`);
    for (const name of Object.keys(metadata.dependencies ?? {})) if (!manifest.packages.some((item) => item.name === name)) throw new Error(`Unbundled runtime dependency: ${name}`);
  }
  const skills = join(temp, 'node_modules/skills');
  execFileSync('git', ['apply', '--unsafe-paths', `--directory=${skills}`, join(source, 'directories.patch')]);
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, 'dist'), { recursive: true });
  const result = await esbuild.build({
    absWorkingDir: temp, entryPoints: ['node_modules/skills/dist/cli.mjs'],
    outfile: join(output, 'dist/cli.mjs'), bundle: true, platform: 'node', format: 'esm',
    target: 'node24', metafile: true, legalComments: 'inline',
    banner: { js: "import { createRequire as postplusCreateRequire } from 'node:module'; const require = postplusCreateRequire(import.meta.url);" },
  });
  const { builtinModules } = await import('node:module');
  for (const record of Object.values(result.metafile.outputs)) for (const item of record.imports) {
    if (item.external && !builtinModules.includes(item.path.replace(/^node:/, ''))) throw new Error(`External runtime dependency remains: ${item.path}`);
  }
  await cp(join(skills, 'package.json'), join(output, 'package.json'));
  await writeFile(join(output, 'cli.mjs'), "#!/usr/bin/env node\nawait import('./dist/cli.mjs');\n");
  for (const pkg of manifest.packages) {
    const directory = join(temp, 'node_modules', pkg.name);
    for (const name of await readdir(directory)) if (/license|notice|copying/i.test(name)) {
      const target = join(output, 'licenses', pkg.name.replaceAll('/', '-'), name);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(directory, name), target, { recursive: true });
    }
  }
  const files = {};
  async function hashFiles(dir, prefix = '') {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await hashFiles(join(dir, entry.name), `${name}/`);
      else files[name] = createHash('sha256').update(await readFile(join(dir, entry.name))).digest('hex');
    }
  }
  await hashFiles(output);
  await writeFile(join(output, 'integrity.json'), JSON.stringify({ ...manifest,
    patchSha256: createHash('sha256').update(await readFile(join(source, 'directories.patch'))).digest('hex'), files }, null, 2) + '\n');
  console.log(`Bundled ${manifest.upstream}; ${manifest.packages.length} verified packages; no external runtime dependencies.`);
} finally { await rm(temp, { recursive: true, force: true }); }
