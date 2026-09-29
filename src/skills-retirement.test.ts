import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { symlink, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { hashSkillDirectory } from './skills-bundle.js';

const cli = fileURLToPath(new URL('./index.ts', import.meta.url));
const installer = fileURLToPath(new URL('../vendor/skills-runtime/cli.mjs', import.meta.url));
const tsx = import.meta.resolve('tsx');

// Real child processes and installer, isolated from the user's HOME and network.
const retired = ['social-media-extractor', 'generation-router', 'media-router', 'postplus-shared'];
for (const scope of ['global', 'project'] as const) {
 for (const condition of ['trusted', 'modified', 'lock-only', 'missing-metadata'] as const) {
  test(`retirement: ${scope} ${condition}`, { timeout: 180_000 }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'postplus installer acceptance ')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const project = join(root, 'project');
    const config = join(root, 'config');
    const bundle = join(root, 'bundle');
    await Promise.all([home, project, config, join(bundle, 'skills/demo')].map((path) => mkdir(path, { recursive: true })));
    const publish = async (names: string[], releaseId: string) => {
      const skills = [];
      for (const name of names) {
        const directory = join(bundle, 'skills', name);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Retirement acceptance fixture.\n---\nOfficial ${name}.\n`);
        skills.push({ name, path: `skills/${name}/SKILL.md`, contentHash: await hashSkillDirectory(directory) });
      }
      await writeFile(join(bundle, 'skills/catalog.json'), JSON.stringify({ schemaVersion: 2, releaseId, source: 'PostPlusAI/postplus-skills', skills: skills.map(({ name, path }) => ({ name, path, status: 'released' })) }));
      await writeFile(join(bundle, 'skills-manifest.json'), JSON.stringify({ schemaVersion: 1, releaseId, skills }));
    };
    await publish(['demo', ...retired], 'skills-2026-09-17.1');
    const guard = join(root, 'no-network.cjs');
    await writeFile(guard, `const fs = require('node:fs'); const deny = () => { fs.appendFileSync(${JSON.stringify(join(root, 'network-attempts'))}, new Error('network attempt').stack + '\\n'); throw new Error('Network forbidden in installer acceptance'); }; globalThis.fetch = deny; for (const name of ['node:http','node:https']) { const m=require(name); m.request=deny; m.get=deny; } const net = require('node:net'); const connect = net.Socket.prototype.connect; net.Socket.prototype.connect = function (...args) { const options = Array.isArray(args[0]) ? args[0][0] : args[0]; if (options && typeof options === 'object' && typeof options.path === 'string') return connect.apply(this, args); return deny(); }; require('node:module').syncBuiltinESMExports();`);
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.state'),
      CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
      VIBE_HOME: join(home, '.vibe'), HERMES_HOME: join(home, '.hermes'),
      AUTOHAND_HOME: join(home, '.autohand'), GROK_HOME: join(home, '.grok'),
      SARVAM_HOME: join(home, '.sarvam'), APPDATA: join(home, '.appdata'),
      FLATPAK_XDG_CONFIG_HOME: join(home, '.flatpak'),
      POSTPLUS_CONFIG_DIR: config, POSTPLUS_SKILLS_SOURCE: bundle,
      DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
      NODE_OPTIONS: `--require=${JSON.stringify(guard)}`,
    };
    delete env.POSTPLUS_SKILLS_CATALOG_URL;
    delete env.POSTPLUS_CLIENT_RECOVERY_ATTEMPT;
    delete env.POSTPLUS_CLIENT_RECOVERY_COMPONENTS;
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    const flags = scope === 'global' ? [] : ['--current-directory'];
    const install = (...extra: string[]) => run(['--import', tsx, cli, 'install', '--json', ...flags, ...extra]);
    const list = async () => {
      const result = await run([installer, 'list', '--json', ...(scope === 'global' ? ['--global'] : [])]);
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout) as Array<{ name: string; directories: Array<{ path: string; realPath: string; agentIds: string[] }> }>;
    };
    const first = await install();
    assert.equal(first.code, 0, first.stdout + first.stderr);
    const entries = await list();
    const baselinePath = join(scope === 'global' ? home : project, '.postplus-skills.json');
    const demo = entries.find(entry => entry.name === 'demo')!.directories;
    const beforeDemo = await Promise.all(demo.map(async entry => ({ path: entry.path, hash: await hashSkillDirectory(entry.path), mtime: (await lstat(join(entry.path, 'SKILL.md'))).mtimeMs })));
    const retiredPaths = [...new Set(entries.filter(entry => retired.includes(entry.name)).flatMap(entry => entry.directories.map(directory => directory.realPath)))];
    if (condition === 'modified' || condition === 'missing-metadata') {
      for (const directory of retiredPaths) {
        if (condition === 'missing-metadata') await rm(join(directory, 'SKILL.md'));
        await writeFile(join(directory, 'personal-notes.txt'), 'Preserve my content.');
      }
    }
    if (condition === 'lock-only') {
      // Historical ownership comes from the upstream lock, never its content hash.
      await rm(baselinePath);
      const lockPath = scope === 'global' ? join(home, '.state/skills/.skill-lock.json') : join(project, 'skills-lock.json');
      await mkdir(join(home, '.state/skills'), { recursive: true });
      await writeFile(lockPath, JSON.stringify({ version: 3, skills: Object.fromEntries(retired.map(name => [name, { source: 'PostPlusAI/postplus-skills', sourceType: 'github', skillFolderHash: '0'.repeat(40) }])) }));
    }
    for (const name of retired) await rm(join(bundle, 'skills', name), { recursive: true });
    await publish(['demo'], 'skills-2026-09-19.1');
    const result = await install();
    assert.equal(result.code, 0, result.stdout + result.stderr);
    await assert.rejects(readdir(join(config, 'skill-backups')), {code:'ENOENT'});
    assert.equal(JSON.parse(await readFile(baselinePath, 'utf8')).releaseId, 'skills-2026-09-19.1');
    assert.deepEqual((await list()).map(entry => entry.name), ['demo']);
    assert.deepEqual(await Promise.all(demo.map(async entry => ({ path: entry.path, hash: await hashSkillDirectory(entry.path), mtime: (await lstat(join(entry.path, 'SKILL.md'))).mtimeMs }))), beforeDemo);
    if (scope === 'global' && condition === 'trusted') {
      const removable = join(home, '.codex/skills/retired-example');
      const unrelated = join(root, 'outside');
      await mkdir(removable, {recursive:true});
      await mkdir(unrelated);
      await writeFile(join(removable, 'SKILL.md'), 'Old same-name content');
      await writeFile(join(unrelated, 'keep'), 'Unrelated content');
      const plan = {schemaVersion:2, scope:'global', names:['retired-example'], entries:[{name:'retired-example',path:removable,realPath:await realpath(removable)}]};
      const planFile = join(root, 'removal.json');
      const invoke = async (value: unknown) => {await writeFile(planFile, JSON.stringify(value)); return run([installer,'remove','--postplus-remove-plan',planFile]);};
      for (const invalid of [
        {...plan,names:[]},
        {...plan,entries:[{...plan.entries[0],path:unrelated,realPath:unrelated}]},
        {...plan,entries:[{...plan.entries[0],realPath:unrelated}]},
      ]) {
        const rejected = await invoke(invalid);
        assert.notEqual(rejected.code, 0, rejected.stdout + rejected.stderr);
        assert.equal(await readFile(join(removable,'SKILL.md'),'utf8'), 'Old same-name content');
      }
      // Removing an enumerated link must never traverse and delete its external target.
      await rm(removable, {recursive:true}); await symlink(unrelated, removable);
      assert.notEqual((await invoke(plan)).code, 0, 'Changed directory identity requires re-enumeration');
      plan.entries[0]!.realPath = await realpath(removable);
      const removed = await invoke(plan);
      assert.equal(removed.code, 0, removed.stdout + removed.stderr);
      await assert.rejects(lstat(removable), {code:'ENOENT'});
      assert.equal(await readFile(join(unrelated,'keep'),'utf8'), 'Unrelated content');
    }
    assert.equal(await readFile(join(root, 'network-attempts'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }), '');
  });
 }
}
