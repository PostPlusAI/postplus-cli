import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { POSTPLUS_SKILLS_AGENT_TARGETS } from './skill-catalog.js';
import { hashSkillDirectory } from './skills-bundle.js';

const cli = fileURLToPath(new URL('./index.ts', import.meta.url));
const installer = fileURLToPath(new URL('../vendor/skills-runtime/cli.mjs', import.meta.url));
const tsx = import.meta.resolve('tsx');

// Real child processes and installer, isolated from the user's HOME and network.
for (const scope of ['global', 'project'] as const) {
  test(`real bundled installer: ${scope} reuse, independent modification, backup and missing target`, { timeout: 180_000 }, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'postplus installer acceptance ')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const project = join(root, 'project');
    const config = join(root, 'config');
    const bundle = join(root, 'bundle');
    await Promise.all([home, project, config, join(bundle, 'skills/demo')].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(bundle, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Isolated acceptance fixture.\n---\nOfficial content.\n');
    const contentHash = await hashSkillDirectory(join(bundle, 'skills/demo'));
    await writeFile(join(bundle, 'skills/catalog.json'), JSON.stringify({ schemaVersion: 2, releaseId: 'skills-2026-09-17.1', source: 'PostPlusAI/postplus-skills', skills: [{ name: 'demo', path: 'skills/demo/SKILL.md', status: 'released' }] }));
    await writeFile(join(bundle, 'skills-manifest.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'skills-2026-09-17.1', skills: [{ name: 'demo', path: 'skills/demo/SKILL.md', contentHash }] }));
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
    const first = scope === 'global'
      ? await run(['--import', tsx, cli, 'install', ...flags])
      : await install();
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.equal(first.stderr, '');
    if (scope === 'global') {
      assert.equal(first.stdout.trim().split('\n').length, 1);
      assert.match(first.stdout, /ready on disk.*Start a new agent session/);
    } else {
      const result = JSON.parse(first.stdout);
      assert.equal(result.ok, true);
      assert.equal(result.changed, true);
      assert.equal(result.diskReady, true);
      assert.equal(result.session.newSessionRequired, true);
      assert.equal(result.backup, null);
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

    // Turn one link into a distinct copy, as older --copy installations do.
    const independent = directories.find((entry) => entry.agentIds.includes('claude-code'))!;
    if ((await lstat(independent.path)).isSymbolicLink()) {
      await rm(independent.path);
      await cp(independent.realPath, independent.path, { recursive: true });
    }
    const modified = (await readFile(join(independent.path, 'SKILL.md'), 'utf8')) + '\nUser customization.\n';
    await writeFile(join(independent.path, 'SKILL.md'), modified);
    const blocked = await install();
    assert.equal(blocked.code, 1, blocked.stdout + blocked.stderr);
    assert.equal(JSON.parse(blocked.stdout).error.code, 'postplus_skills_requires_human');
    assert.equal(JSON.parse(blocked.stdout).error.contentState, 'modified');
    assert.equal(JSON.parse(blocked.stdout).error.stage, 'skills_content_verification');
    assert.deepEqual(JSON.parse(blocked.stdout).error.conflicts, [{ name: 'demo', path: independent.path, state: 'modified' }]);
    assert.match(JSON.parse(blocked.stdout).error.action, /postplus install/);
    assert.doesNotMatch(JSON.parse(blocked.stdout).error.action, /postplus update/);
    assert.ok(JSON.parse(blocked.stdout).error.message.includes(independent.path));
    // The same bytes cannot be called modified when the trusted old fingerprint
    // is absent. Both old official-looking and damaged content remain unknown.
    const legacyBaseline = JSON.parse(before);
    delete legacyBaseline.contentHashes;
    await writeFile(baselinePath, JSON.stringify(legacyBaseline));
    for (const bytes of ['---\nname: demo\ndescription: Previous official fixture.\n---\nPrevious release content.\n', 'damaged skill content']) {
      await writeFile(join(independent.path, 'SKILL.md'), bytes);
      for (const command of ['install', 'update']) {
        env.POSTPLUS_CLIENT_RECOVERY_COMPONENTS = 'skills';
        const unknown = await run(['--import', tsx, cli, command, '--json', ...flags]);
        delete env.POSTPLUS_CLIENT_RECOVERY_COMPONENTS;
        assert.equal(unknown.code, 1, unknown.stdout + unknown.stderr);
        const fact = JSON.parse(unknown.stdout).error;
        assert.equal(fact.code, 'postplus_skills_content_unverified');
        assert.equal(fact.contentState, 'unverified');
        assert.equal(fact.stage, 'skills_content_verification');
        assert.match(fact.message, /cannot be verified as managed/);
        assert.doesNotMatch(fact.message, /user.modif/i);
        assert.match(fact.action, new RegExp(`postplus ${command}.*--yes`));
        assert.equal(await readFile(join(independent.path, 'SKILL.md'), 'utf8'), bytes);
        assert.deepEqual(JSON.parse(await readFile(baselinePath, 'utf8')), legacyBaseline);
      }
      env.POSTPLUS_CLIENT_RECOVERY_ATTEMPT = '1';
      const exhausted = JSON.parse((await install()).stdout).error;
      delete env.POSTPLUS_CLIENT_RECOVERY_ATTEMPT;
      assert.equal(exhausted.code, 'postplus_skills_content_unverified');
      assert.equal(exhausted.recovery.exhausted, true);
      assert.match(exhausted.action, /^Stop automatic recovery/);
      assert.doesNotMatch(exhausted.action, /run postplus/);
      const plainUnknown = await run(['--import', tsx, cli, 'install', ...flags]);
      assert.equal(plainUnknown.code, 1);
      assert.equal(plainUnknown.stdout, '');
      assert.equal(plainUnknown.stderr.trim().split('\n').length, 2);
      assert.match(plainUnknown.stderr, /cannot be verified as managed/);
    }
    await writeFile(baselinePath, before);
    await writeFile(join(independent.path, 'SKILL.md'), modified);
    const verification = await run(['--import',tsx,cli,'skills','verify','--json']);
    assert.equal(verification.code,1);
    const report=JSON.parse(verification.stdout);
    assert.equal(report.installedCount,1);
    assert.equal(report.ok,false);
    assert.ok(report.targetIssues.some((issue: {paths:string[]})=>issue.paths.includes(independent.path)));

    assert.equal(await readFile(join(independent.path, 'SKILL.md'), 'utf8'), modified);
    assert.equal(await readFile(baselinePath, 'utf8'), before);
    const approved = await install('--yes');
    assert.equal(approved.code, 0, approved.stdout + approved.stderr);
    assert.equal(approved.stderr, '');
    assert.equal(JSON.parse(approved.stdout).session.newSessionRequired, true);
    assert.equal(JSON.parse(approved.stdout).backup.skillCount, 1);
    assert.ok(JSON.parse(approved.stdout).backup.path);
    const backupRoot = join(config, 'skill-backups');
    const backups = await readdir(backupRoot);
    assert.equal(backups.length, 1);
    const backup = JSON.parse(await readFile(join(backupRoot, backups[0]!, 'manifest.json'), 'utf8'));
    assert.equal(backup.skills.length, 1);
    assert.equal(await readFile(join(backup.skills[0].backupPath, 'SKILL.md'), 'utf8'), modified);
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
    // An occupied slot or broken link must stop even with overwrite approval.
    // No installer write or baseline advance is safe until the path is resolved.
    const savedSlot = join(root, 'saved-slot');
    await rename(missing.path, savedSlot);
    const protectedBaseline = await readFile(baselinePath, 'utf8');
    for (const abnormal of ['occupied-file', 'dangling-link']) {
      if (abnormal === 'occupied-file') await writeFile(missing.path, 'User-owned file.');
      else await symlink(join(root, 'nonexistent-target'), missing.path);
      const rejected = await install('--yes');
      assert.equal(rejected.code, 1, rejected.stdout + rejected.stderr);
      assert.equal(JSON.parse(rejected.stdout).error.code, 'postplus_skills_directory_unreadable');
      assert.equal(await readFile(baselinePath, 'utf8'), protectedBaseline);
      if (abnormal === 'occupied-file') assert.equal(await readFile(missing.path, 'utf8'), 'User-owned file.');
      else assert.equal(await readlink(missing.path), join(root, 'nonexistent-target'));
      await rm(missing.path);
    }
    await rename(savedSlot, missing.path);
    const original = await readFile(join(missing.path, 'SKILL.md'), 'utf8');
    await writeFile(join(missing.path, 'SKILL.md'), original.replace('name: demo', 'name: user-renamed'));
    const renamed = await install();
    assert.equal(renamed.code, 1, renamed.stdout + renamed.stderr);
    assert.equal(JSON.parse(renamed.stdout).error.code, 'postplus_skills_requires_human');
    assert.match(await readFile(join(missing.path, 'SKILL.md'), 'utf8'), /user-renamed/);
    await rm(join(missing.path, 'SKILL.md'));
    await writeFile(join(missing.path, 'personal-notes.txt'), 'Do not overwrite my notes.');
    const noMetadata = await install();
    assert.equal(noMetadata.code, 1, noMetadata.stdout + noMetadata.stderr);
    assert.equal(JSON.parse(noMetadata.stdout).error.code, 'postplus_skills_requires_human');
    assert.equal(await readFile(join(missing.path, 'personal-notes.txt'), 'utf8'), 'Do not overwrite my notes.');
    const uninstall = (...extra: string[]) => run(['--import', tsx, cli, 'uninstall', '--json', ...flags, ...extra]);
    const removeBlocked = await uninstall();
    assert.equal(removeBlocked.code, 1, removeBlocked.stdout + removeBlocked.stderr);
    assert.equal(JSON.parse(removeBlocked.stdout).error.code, 'postplus_skills_requires_human');
    const removed = await uninstall('--yes');
    assert.equal(removed.code, 0, removed.stdout + removed.stderr);
    assert.equal(JSON.parse(removed.stdout).outcome, 'uninstalled');
    assert.equal((await list()).filter((entry) => entry.name === 'demo').length, 0);
    const finalBackups = await readdir(backupRoot);
    assert.equal(finalBackups.length, 2);
    const removalBackup = JSON.parse(await readFile(join(backupRoot, finalBackups.find((name) => name !== backups[0])!, 'manifest.json'), 'utf8'));
    assert.equal(await readFile(join(removalBackup.skills[0].backupPath, 'personal-notes.txt'), 'utf8'), 'Do not overwrite my notes.');
    assert.equal(await readFile(join(root, 'network-attempts'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; }), '', 'Local install must not attempt network access');
    t.diagnostic(`${scope}: real installer; repeat unchanged; modified copy blocked and backed up; missing target repaired; renamed/missing metadata protected; network attempts=0`);
  });
}
