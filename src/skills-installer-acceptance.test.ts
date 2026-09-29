import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { POSTPLUS_SKILLS_AGENT_TARGETS } from './skill-catalog.js';
import { hashSkillDirectory } from './skills-bundle.js';

const cli = fileURLToPath(new URL('./index.ts', import.meta.url));
const installer = fileURLToPath(new URL('../vendor/skills-runtime/cli.mjs', import.meta.url));
const tsx = import.meta.resolve('tsx');

// Real child processes and installer, isolated from the user's HOME and network.
for (const scope of ['global', 'project'] as const) {
  test(`real bundled installer: ${scope} reuse, independent copies, overwrite and missing target`, { timeout: 180_000 }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'postplus installer acceptance ')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const project = join(root, 'project');
    const config = join(root, 'config');
    const bundle = join(root, 'bundle');
    await Promise.all([home, project, config, join(bundle, 'skills/demo')].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(bundle, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Isolated acceptance fixture.\n---\nOfficial content.\n');
    const contentHash = await hashSkillDirectory(join(bundle, 'skills/demo'));
    await writeFile(join(bundle, 'skills/catalog.json'), JSON.stringify({ schemaVersion: 2, releaseId: 'skills-2026-09-17.1', discoveryCategories: { create: { title: 'Create media' } }, source: 'PostPlusAI/postplus-skills', skills: [{ name: 'demo', path: 'skills/demo/SKILL.md', status: 'released', description: 'Create a useful image.', category: 'create', example: 'Make an image for my campaign.' }] }));
    await writeFile(join(bundle, 'skills-manifest.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'skills-2026-09-17.1', skills: [{ name: 'demo', path: 'skills/demo/SKILL.md', contentHash }] }));
    const guard = join(root, 'no-network.cjs');
    await writeFile(guard, `if (process.env.POSTPLUS_TEST_FAIL_AGENT && process.argv.includes('add') && process.argv.includes(process.env.POSTPLUS_TEST_FAIL_AGENT)) process.exit(17); const fs = require('node:fs'); const deny = () => { fs.appendFileSync(${JSON.stringify(join(root, 'network-attempts'))}, new Error('network attempt').stack + '\\n'); throw new Error('Network forbidden in installer acceptance'); }; globalThis.fetch = deny; for (const name of ['node:http','node:https']) { const m=require(name); m.request=deny; m.get=deny; } const net = require('node:net'); const connect = net.Socket.prototype.connect; net.Socket.prototype.connect = function (...args) { const options = Array.isArray(args[0]) ? args[0][0] : args[0]; if (options && typeof options === 'object' && typeof options.path === 'string') return connect.apply(this, args); return deny(); }; require('node:module').syncBuiltinESMExports();`);
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
    const first = scope === 'global'
      ? await run(['--import', tsx, cli, 'install', ...flags])
      : await install();
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.equal(first.stderr, '');
    if (scope === 'global') {
      assert.match(first.stdout, /Try PostPlus with your agent:/);
      assert.match(first.stdout, /Create media/);
      assert.match(first.stdout, /Make an image for my campaign/);
      assert.match(first.stdout, /ready on disk.*Start a new agent session/);
    } else {
      const result = JSON.parse(first.stdout);
      assert.equal(result.ok, true);
      assert.equal(result.changed, true);
      assert.equal(result.diskReady, true);
      assert.equal(result.session.newSessionRequired, true);
      assert.equal('backup' in result, false);
    }
    let directories = (await list()).find((entry) => entry.name === 'demo')!.directories;
    assert.deepEqual([...new Set(directories.flatMap((entry) => entry.agentIds).filter((id) => POSTPLUS_SKILLS_AGENT_TARGETS.includes(id as never)))].sort(), [...POSTPLUS_SKILLS_AGENT_TARGETS].sort());
    const baselinePath = join(scope === 'global' ? home : project, '.postplus-skills.json');
    const before = await readFile(baselinePath, 'utf8');
    const mtimes = await Promise.all(directories.map(async (entry) => (await lstat(join(entry.realPath, 'SKILL.md'))).mtimeMs));
    const second = await install();
    assert.equal(second.code, 0, second.stdout + second.stderr);
    assert.equal(JSON.parse(second.stdout).outcome, 'current');
    assert.equal(second.stderr, '');
    assert.deepEqual(JSON.parse(second.stdout).session, { newSessionRequired: false, action: null });
    assert.equal(JSON.parse(second.stdout).changed, false);
    const plainCurrent = await run(['--import', tsx, cli, 'install', ...flags]);
    assert.equal(plainCurrent.code, 0, plainCurrent.stderr);
    assert.equal(plainCurrent.stderr, '');
    assert.equal(plainCurrent.stdout.trim().split('\n').length, 1);
    assert.doesNotMatch(plainCurrent.stdout, /new agent session|restart/i);
    assert.equal(await readFile(baselinePath, 'utf8'), before);
    assert.deepEqual(await Promise.all(directories.map(async (entry) => (await lstat(join(entry.realPath, 'SKILL.md'))).mtimeMs)), mtimes);

    // A missing baseline is repair, not a new user's first encounter.
    if (scope === 'global') {
      await rm(baselinePath);
      const rediscovered = await run(['--import', tsx, cli, 'install']);
      assert.equal(rediscovered.code, 0, rediscovered.stdout + rediscovered.stderr);
      assert.doesNotMatch(rediscovered.stdout, /Try PostPlus with your agent/);
    }

    // Turn one link into a distinct copy, as older --copy installations do.
    const independent = directories.find((entry) => entry.agentIds.includes('claude-code'))!;
    if ((await lstat(independent.path)).isSymbolicLink()) {
      await rm(independent.path);
      await cp(independent.realPath, independent.path, { recursive: true });
    }
    const modified = (await readFile(join(independent.path, 'SKILL.md'), 'utf8')) + '\nUser customization.\n';
    await writeFile(join(independent.path, 'SKILL.md'), modified);
    const verification = await run(['--import',tsx,cli,'skills','verify','--json']);
    assert.equal(verification.code, 1);
    assert.equal(JSON.parse(verification.stdout).ok, false);
    assert.equal(await readFile(join(independent.path, 'SKILL.md'), 'utf8'), modified);
    const overwritten = await install();
    assert.equal(overwritten.code, 0, overwritten.stdout + overwritten.stderr);
    assert.equal(overwritten.stderr, '');
    assert.equal(JSON.parse(overwritten.stdout).session.newSessionRequired, true);
    const backupRoot = join(config, 'skill-backups');
    await assert.rejects(readdir(backupRoot), {code:'ENOENT'});
    // Old clients may have no fingerprints. Metadata and old release naming do not block repair.
    for (const bytes of ['---\nname: other-owner\ndescription: Unrelated same-name content.\n---\nOld contents.\n', 'damaged skill content']) {
      for (const command of ['install', 'update']) {
        await writeFile(join(independent.path, 'SKILL.md'), bytes);
        await writeFile(join(independent.path, 'old-extra.txt'), 'Must not survive replacement');
        const legacyBaseline = {...JSON.parse(before), releaseId:'legacy-version'};
        legacyBaseline.contentHashes = 'obsolete fingerprints are ignored';
        await writeFile(baselinePath, JSON.stringify(legacyBaseline));
        env.POSTPLUS_CLIENT_RECOVERY_COMPONENTS = 'skills';
        env.POSTPLUS_CLIENT_RECOVERY_ATTEMPT = '1';
        const repaired = await run(['--import', tsx, cli, command, '--json', ...flags]);
        delete env.POSTPLUS_CLIENT_RECOVERY_COMPONENTS;
        delete env.POSTPLUS_CLIENT_RECOVERY_ATTEMPT;
        assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
        assert.equal(repaired.stderr, '');
        assert.equal(await hashSkillDirectory(independent.path), contentHash);
        await assert.rejects(readFile(join(independent.path, 'old-extra.txt')), {code:'ENOENT'});
      }
    }
    // Reproduce the legacy Codex copy beside the modern shared installation.
    const codexLegacy = join(scope === 'global' ? home : project, '.codex/skills/demo');
    await mkdir(codexLegacy, {recursive:true});
    await writeFile(join(codexLegacy, 'SKILL.md'), 'Legacy Codex content without metadata');
    const codexRepair = await install();
    assert.equal(codexRepair.code, 0, codexRepair.stdout + codexRepair.stderr);
    const codexEntries = (await list()).find(entry => entry.name === 'demo')!.directories;
    for (const entry of codexEntries) assert.equal(await hashSkillDirectory(entry.path), contentHash);
    directories = (await list()).find((entry) => entry.name === 'demo')!.directories;
    for (const entry of directories) assert.equal(await hashSkillDirectory(entry.path), contentHash);
    const missing = directories.find((entry) => entry.agentIds.includes('windsurf'))!;
    await rm(missing.path, { recursive: true, force: true });
    const correctDirectories = directories.filter((entry) => entry.path !== missing.path);
    const snapshotCorrectDirectories = async () => Promise.all(correctDirectories.map(async (entry) => {
      const slot = await lstat(entry.path);
      const content = await lstat(join(entry.realPath, 'SKILL.md'));
      return {
        path: entry.path,
        link: slot.isSymbolicLink() ? await readlink(entry.path) : null,
        slot: { ino: slot.ino, mode: slot.mode, ctimeMs: slot.ctimeMs, mtimeMs: slot.mtimeMs },
        content: { ino: content.ino, ctimeMs: content.ctimeMs, mtimeMs: content.mtimeMs },
        hash: await hashSkillDirectory(entry.path),
      };
    }));
    const correctBeforeRepair = await snapshotCorrectDirectories();
    const repaired = await install();
    assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
    assert.equal(repaired.stderr, '');
    assert.equal(JSON.parse(repaired.stdout).session.newSessionRequired, true);
    assert.equal(JSON.parse(repaired.stdout).outcome, 'repaired');
    assert.equal(await hashSkillDirectory(missing.path), contentHash);
    assert.deepEqual(await snapshotCorrectDirectories(), correctBeforeRepair,
      'Repairing a missing target must preserve already-correct contents, file identities and links');
    assert.equal((await install()).code, 0);
    await writeFile(join(bundle, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Updated acceptance fixture.\n---\nNew official content.\n');
    const newHash = await hashSkillDirectory(join(bundle, 'skills/demo'));
    const nextRelease = 'skills-2026-09-18.1';
    const catalog = JSON.parse(await readFile(join(bundle, 'skills/catalog.json'), 'utf8'));
    catalog.releaseId = nextRelease;
    await writeFile(join(bundle, 'skills/catalog.json'), JSON.stringify(catalog));
    await writeFile(join(bundle, 'skills-manifest.json'), JSON.stringify({ schemaVersion: 1, releaseId: nextRelease, skills: [{ name: 'demo', path: 'skills/demo/SKILL.md', contentHash: newHash }] }));
    const updated = await install();
    assert.equal(updated.code, 0, updated.stdout + updated.stderr);
    assert.equal(updated.stderr, '');
    assert.equal(JSON.parse(updated.stdout).outcome, 'updated');
    assert.equal(JSON.parse(updated.stdout).session.newSessionRequired, true);
    assert.equal(await hashSkillDirectory(missing.path), newHash);
    // A partial installation never advances the release; the same command repairs it.
    const baselineBeforeFailure = await readFile(baselinePath, 'utf8');
    catalog.releaseId = 'skills-2026-09-19.1';
    await writeFile(join(bundle, 'skills/catalog.json'), JSON.stringify(catalog));
    await writeFile(join(bundle, 'skills-manifest.json'), JSON.stringify({schemaVersion:1,releaseId:catalog.releaseId,skills:[{name:'demo',path:'skills/demo/SKILL.md',contentHash:newHash}]}));
    await writeFile(join(missing.path, 'old-file'), 'Incomplete old content');
    env.POSTPLUS_TEST_FAIL_AGENT = 'windsurf';
    const failed = await install();
    delete env.POSTPLUS_TEST_FAIL_AGENT;
    assert.equal(failed.code, 1, failed.stdout + failed.stderr);
    assert.equal(JSON.parse(failed.stdout).ok, false);
    assert.equal(JSON.parse(failed.stdout).error.code, 'postplus_skill_install_failed');
    assert.equal(await readFile(baselinePath, 'utf8'), baselineBeforeFailure);
    assert.equal((await list()).some(entry => entry.name === 'demo'), true, 'Some targets completed before the failure');
    const resumed = await install();
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
    assert.equal(JSON.parse(await readFile(baselinePath, 'utf8')).releaseId, catalog.releaseId);
    for (const entry of (await list()).find(entry => entry.name === 'demo')!.directories) {
      assert.equal(await hashSkillDirectory(entry.path), newHash);
    }
    // Same-name files and dangling links are ordinary replacement targets.
    for (const abnormal of ['occupied-file', 'dangling-link']) {
      await rm(missing.path, {recursive:true, force:true});
      if (abnormal === 'occupied-file') await writeFile(missing.path, 'User-owned file.');
      else await symlink(join(root, 'nonexistent-target'), missing.path);
      const repaired = await install();
      assert.equal(repaired.code, 0, repaired.stdout + repaired.stderr);
      assert.equal(await hashSkillDirectory(missing.path), newHash);
    }
    // Whole agent skill roots may alias the shared directory; remove a physical slot only once.
    const beforeAlias = (await list()).find(entry => entry.name === 'demo')!.directories;
    const aliasSlot = beforeAlias.find(entry => entry.agentIds.includes('trae-cn'))!;
    const canonical = beforeAlias.find(entry => entry.path === entry.realPath)!;
    assert.notEqual(dirname(aliasSlot.path), dirname(canonical.path));
    await rm(dirname(aliasSlot.path), {recursive:true});
    await symlink(dirname(canonical.path), dirname(aliasSlot.path), 'dir');
    await writeFile(join(canonical.path, 'SKILL.md'), 'Stale content through aliased roots');
    const aliasRepair = await install();
    assert.equal(aliasRepair.code, 0, aliasRepair.stdout + aliasRepair.stderr);
    for (const entry of (await list()).find(entry => entry.name === 'demo')!.directories) {
      assert.equal(await hashSkillDirectory(entry.path), newHash);
    }
    const original = await readFile(join(missing.path, 'SKILL.md'), 'utf8');
    await writeFile(join(missing.path, 'SKILL.md'), original.replace('name: demo', 'name: user-renamed'));
    const renamed = await install();
    assert.equal(renamed.code, 0, renamed.stdout + renamed.stderr);
    assert.equal(await hashSkillDirectory(missing.path), newHash);
    await rm(join(missing.path, 'SKILL.md'));
    await writeFile(join(missing.path, 'personal-notes.txt'), 'Same-name contents are replaced.');
    const noMetadata = await install();
    assert.equal(noMetadata.code, 0, noMetadata.stdout + noMetadata.stderr);
    assert.equal(await hashSkillDirectory(missing.path), newHash);
    await rm(join(missing.path, 'SKILL.md'));
    await writeFile(join(missing.path, 'personal-notes.txt'), 'Same-name contents are removed.');
    const removed = await run(['--import', tsx, cli, 'uninstall', '--json', ...flags]);
    assert.equal(removed.code, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).outcome, 'uninstalled');
    assert.equal((await list()).filter((entry) => entry.name === 'demo').length, 0);
    await assert.rejects(readdir(backupRoot), {code:'ENOENT'});
    assert.equal((await readdir(config)).some(name => name.startsWith('skills-sync-')), false);
    assert.equal(await readFile(join(root, 'network-attempts'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; }), '', 'Local install must not attempt network access');
    t.diagnostic(`${scope}: real installer; repeat unchanged; modified and legacy Codex copies replaced; missing target repaired; renamed/missing metadata replaced; no backups; network attempts=0`);
  });
}
