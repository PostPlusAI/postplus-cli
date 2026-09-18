import { serializeInstallerEntries } from './fixtures/skills-bundle-fixture.test.js';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hashSkillDirectory, readSkillsManifest, UnsupportedSkillEntryError } from './skills-bundle.js';
import { loadPublicSkillCatalog } from './skill-catalog.js';
import { runPostPlusSkillUpdate } from './skill-management.js';
import { readManagedSkillBaseline, writeManagedSkillBaseline } from './skill-installation.js';

const labels = ['Claude Code', 'Codex', 'Cursor', 'GitHub Copilot', 'Windsurf', 'Trae', 'Trae CN', 'OpenClaw', 'Hermes Agent'];
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'postplus-bundle-test-'));
  const previous = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(root, { recursive: true, force: true });
  });
  const bundle = join(root, 'bundle');
  const skill = join(bundle, 'skills/demo');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: demo\ndescription: Example\n---\nOfficial content\n');
  const contentHash = await hashSkillDirectory(skill);
  const manifest = { schemaVersion: 1, releaseId: 'skills-2026-09-16.1', skills: [{ name: 'demo', path: 'skills/demo/SKILL.md', contentHash }] };
  await writeFile(join(bundle, 'skills-manifest.json'), JSON.stringify(manifest));
  await writeFile(join(bundle, 'skills/catalog.json'), JSON.stringify({ schemaVersion: 2, releaseId: manifest.releaseId, source: 'PostPlusAI/postplus-skills', skills: [{ name: 'demo', path: 'skills/demo/SKILL.md', status: 'released' }] }));
  Object.assign(process.env, { HOME: root, USERPROFILE: root, POSTPLUS_CONFIG_DIR: join(root, 'config'), POSTPLUS_SKILLS_SOURCE: bundle });
  delete process.env.POSTPLUS_SKILLS_CATALOG_URL;
  const installed = join(root, 'installed/demo');
  return { root, bundle, skill, installed, manifest, contentHash };
}

test('bundle hash is deterministic and agrees with the release generator binary golden', async (t) => {
  const { skill } = await setup(t);
  await writeFile(join(skill, 'SKILL.md'), 'Test skill');
  await mkdir(join(skill, 'references'));
  await writeFile(join(skill, 'references/data.bin'), Buffer.from([0, 1, 255]));
  assert.equal(await hashSkillDirectory(skill), '2302da248627783bcc35e732a215e09a0aa7e89068287070a3c7f1799a3adaa0');
});

test('default content lookup never fetches and damaged bundle fails without remote fallback', async (t) => {
  const { bundle, skill } = await setup(t);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network must not be used'); };
  t.after(() => { globalThis.fetch = original; });
  assert.equal((await loadPublicSkillCatalog()).skills[0]?.skillId, 'demo');
  await writeFile(join(skill, 'SKILL.md'), 'damaged');
  await assert.rejects(readSkillsManifest(bundle), { code: 'postplus_skills_bundle_invalid' });
  await assert.rejects(loadPublicSkillCatalog(), { code: 'postplus_skills_bundle_invalid' });
});

test('bundle rejects traversal and symbolic links', async (t) => {
  const { bundle, manifest, skill } = await setup(t);
  await writeFile(join(bundle, 'skills-manifest.json'), JSON.stringify({ ...manifest, skills: [{ ...manifest.skills[0], path: 'skills/../outside/SKILL.md' }] }));
  await assert.rejects(readSkillsManifest(bundle), { code: 'postplus_skills_bundle_invalid' });
  await symlink(join(skill, 'SKILL.md'), join(skill, 'link'));
  await assert.rejects(hashSkillDirectory(skill), UnsupportedSkillEntryError);
  await writeFile(join(bundle, 'skills-manifest.json'), JSON.stringify(manifest));
  await assert.rejects(readSkillsManifest(bundle), { code: 'postplus_skills_bundle_invalid' });
});

test('matching target content adopts baseline despite stale third-party lock and repeats without installation', async (t) => {
  const fixture = await setup(t);
  await cp(fixture.skill, fixture.installed, { recursive: true });
  await mkdir(join(fixture.root, '.agents'));
  await writeFile(join(fixture.root, '.agents/.skill-lock.json'), JSON.stringify({ version: 3, skills: { demo: { source: 'PostPlusAI/postplus-skills', skillFolderHash: 'stale' } } }));
  let mutations = 0;
  const deps = { runCommand: async () => ({ stderr: '', stdout: serializeInstallerEntries([{ name: 'demo', path: fixture.installed, scope: 'global', agents: labels }]) }),
    runInteractiveCommand: async () => { mutations++; return 0; },
    isInteractive: () => false,
  };
  assert.equal(await runPostPlusSkillUpdate(deps, { scope: 'global' }), 0);
  assert.equal(await runPostPlusSkillUpdate(deps, { scope: 'global' }), 0);
  assert.equal(mutations, 0);
  assert.deepEqual((await readManagedSkillBaseline('global')).contentHashes, { demo: fixture.contentHash });
});

test('actual user modification stops without consent, then backs up before explicit replacement', async (t) => {
  const fixture = await setup(t);
  await cp(fixture.skill, fixture.installed, { recursive: true });
  await writeManagedSkillBaseline({ releaseId: fixture.manifest.releaseId, skillNames: ['demo'], contentHashes: { demo: fixture.contentHash } }, 'global');
  await writeFile(join(fixture.installed, 'SKILL.md'), 'My local version');
  let mutations = 0;
  const deps = { runCommand: async () => ({ stderr: '', stdout: serializeInstallerEntries([{ name: 'demo', path: fixture.installed, scope: 'global', agents: labels }]) }),
    runInteractiveCommand: async () => { mutations++; await cp(fixture.skill, fixture.installed, { recursive: true }); return 0; }, isInteractive: () => false,
  };
  await assert.rejects(runPostPlusSkillUpdate(deps, { scope: 'global' }), { code: 'postplus_skills_requires_human' });
  assert.equal(mutations, 0);
  assert.equal(await readFile(join(fixture.installed, 'SKILL.md'), 'utf8'), 'My local version');
  assert.equal(await runPostPlusSkillUpdate(deps, { scope: 'global', yes: true }), 0);
  assert.ok(mutations > 0);
});

test('directories ABI rejects an old or malformed installer payload before any mutation', async (t) => {
  const f = await setup(t);
  let mutations = 0;
  for (const directories of [undefined, [{ path: f.installed, agentIds: ['codex'] }], [{ path: 'relative', realPath: f.installed, agentIds: ['codex'] }]]) {
    const deps = { runCommand: async () => ({ stdout: JSON.stringify([{ name: 'demo', path: f.installed, scope: 'global', agents: ['Codex'], ...(directories === undefined ? {} : { directories }) }]), stderr: '' }), runInteractiveCommand: async () => { mutations++; return 0; } };
    await assert.rejects(runPostPlusSkillUpdate(deps, { scope: 'global' }), { code: 'postplus_skills_installer_abi_invalid' });
  }
  assert.equal(mutations, 0);
  await assert.rejects(runPostPlusSkillUpdate({ runCommand: async () => ({ stdout: '[]', stderr: '' }), runInteractiveCommand: async () => 23 }, { scope: 'global' }), { code: 'postplus_skill_install_failed' });
});

test('one healthy canonical directory cannot mask an independently modified agent copy', async (t) => {
  const f = await setup(t);
  const { realpath } = await import('node:fs/promises');
  await cp(f.skill, f.installed, { recursive: true });
  const copy = join(f.root, 'independent-copy');
  await cp(f.skill, copy, { recursive: true });
  await writeManagedSkillBaseline({ releaseId: f.manifest.releaseId, skillNames: ['demo'], contentHashes: { demo: f.contentHash } }, 'global');
  await writeFile(join(copy, 'SKILL.md'), 'Independent user changes');
  const allIds = ['claude-code', 'codex', 'cursor', 'github-copilot', 'windsurf', 'trae', 'trae-cn', 'openclaw', 'hermes-agent'];
  const directories = [{ path: f.installed, realPath: await realpath(f.installed), directoryName: 'demo', metadataName: 'demo', metadataError: null, agentIds: allIds }, { path: copy, realPath: await realpath(copy), directoryName: 'demo', metadataName: 'demo', metadataError: null, agentIds: ['codex'] }];
  const writes: string[][] = [];
  const deps = { runCommand: async () => ({ stdout: JSON.stringify([{ name: 'demo', path: f.installed, scope: 'global', agents: ['Display labels are not IDs'], directories }]), stderr: '' }), runInteractiveCommand: async (command: string, args: string[]) => { assert.equal(command, process.execPath); assert.match(args[0]!, /vendor\/skills-runtime\/cli\.mjs$/); writes.push(args); await cp(f.skill, copy, { recursive: true }); return 0; }, isInteractive: () => false };
  await assert.rejects(runPostPlusSkillUpdate(deps, { scope: 'global' }), { code: 'postplus_skills_requires_human' });
  assert.equal(writes.length, 0);
  assert.equal(await runPostPlusSkillUpdate(deps, { scope: 'global', yes: true }), 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]![writes[0]!.indexOf('--agent') + 1], 'codex');
  const backups = await (await import('node:fs/promises')).readdir(join(f.root, 'config/skill-backups'));
  const manifest = JSON.parse(await readFile(join(f.root, 'config/skill-backups', backups[0]!, 'manifest.json'), 'utf8'));
  assert.equal(manifest.skills.length, 1);
  assert.equal(await readFile(join(manifest.skills[0].backupPath, 'SKILL.md'), 'utf8'), 'Independent user changes');
});

test('missing agent copy is repaired without approval and shared real directories need only one write', async (t) => {
  const f = await setup(t);
  const { realpath } = await import('node:fs/promises');
  const ids = ['claude-code', 'codex', 'cursor', 'github-copilot', 'windsurf', 'trae', 'trae-cn', 'openclaw', 'hermes-agent'];
  await cp(f.skill, f.installed, { recursive: true });
  const missing = join(await realpath(f.root), 'missing-copy');
  const directories = [{ path: f.installed, realPath: await realpath(f.installed), directoryName: 'demo', metadataName: 'demo', metadataError: null, agentIds: ids }, { path: missing, realPath: missing, directoryName: 'demo', metadataName: 'demo', metadataError: null, agentIds: ['codex'] }];
  let writes = 0;
  const deps = { runCommand: async () => ({ stdout: JSON.stringify([{ name: 'demo', path: f.installed, scope: 'global', agents: [], directories }]), stderr: '' }), runInteractiveCommand: async () => { writes++; await cp(f.skill, missing, { recursive: true }); return 0; }, isInteractive: () => false };
  assert.equal(await runPostPlusSkillUpdate(deps, { scope: 'global' }), 0);
  assert.equal(writes, 1);
  directories.pop();
  await writeFile(join(f.installed, 'SKILL.md'), 'Older official content');
  await writeManagedSkillBaseline({ releaseId: 'skills-2026-09-01.1', skillNames: ['demo'], contentHashes: { demo: await hashSkillDirectory(f.installed) } }, 'global');
  writes = 0;
  assert.equal(await runPostPlusSkillUpdate({ ...deps, runInteractiveCommand: async () => { writes++; await cp(f.skill, f.installed, { recursive: true }); return 0; } }, { scope: 'global' }), 0);
  assert.equal(writes, 1, 'fresh enumeration prevents nine copies of the same canonical update');
});

test('managed slot identity survives edited or missing metadata; unrelated damaged slots do not block it', async (t) => {
  const f = await setup(t);
  const { realpath, unlink } = await import('node:fs/promises');
  await cp(f.skill, f.installed, { recursive: true });
  const realPath = await realpath(f.installed);
  const ids = ['claude-code', 'codex', 'cursor', 'github-copilot', 'windsurf', 'trae', 'trae-cn', 'openclaw', 'hermes-agent'];
  let payload: unknown;
  let writes = 0;
  const deps = { runCommand: async () => ({ stdout: JSON.stringify(payload), stderr: '' }), runInteractiveCommand: async () => { writes++; return 0; }, isInteractive: () => false };
  const entry = (name: string, directoryName: string, metadataName: string | null, metadataError: string | null) => ({ name, path: f.installed, scope: 'global', agents: [], directories: [{ path: f.installed, realPath, agentIds: ids, directoryName, metadataName, metadataError }] });
  await writeFile(join(f.installed, 'SKILL.md'), '---\nname: renamed-user-skill\ndescription: Changed\n---\nMy content');
  payload = [{ name: 'renamed-user-skill', path: f.installed, scope: 'global', agents: [], directories: [] }, entry('demo', 'demo', 'renamed-user-skill', null)];
  await assert.rejects(runPostPlusSkillUpdate(deps, { scope: 'global' }), { code: 'postplus_skills_requires_human' });
  await unlink(join(f.installed, 'SKILL.md'));
  payload = [entry('demo', 'demo', null, 'missing-skill-file')];
  await assert.rejects(runPostPlusSkillUpdate(deps, { scope: 'global' }), { code: 'postplus_skills_requires_human' });
  for (const kind of ['occupied-file', 'dangling-link']) {
    payload = [entry('demo', 'demo', null, kind)];
    await assert.rejects(runPostPlusSkillUpdate(deps, { scope: 'global' }), { code: 'postplus_skills_directory_unreadable' });
  }
  assert.equal(writes, 0);
  await cp(f.skill, f.installed, { recursive: true });
  payload = [entry('demo', 'demo', 'demo', null), entry('unrelated', 'unrelated', null, 'occupied-file')];
  assert.equal(await runPostPlusSkillUpdate(deps, { scope: 'global' }), 0);
  assert.equal(writes, 0);
});

test('two links to the same modified real directory produce one complete backup and one write', async (t) => {
  const f = await setup(t);
  const { realpath, readdir } = await import('node:fs/promises');
  await cp(f.skill, f.installed, { recursive: true });
  await writeFile(join(f.installed, 'SKILL.md'), 'User-owned content');
  const alias = join(f.root, 'alias');
  await symlink(f.installed, alias, 'dir');
  const ids = ['claude-code', 'codex', 'cursor', 'github-copilot', 'windsurf', 'trae', 'trae-cn', 'openclaw', 'hermes-agent'];
  const realPath = await realpath(f.installed);
  const directories = [f.installed, alias].map((path) => ({ path, realPath, directoryName: 'demo', metadataName: 'demo', metadataError: null, agentIds: ids }));
  let writes = 0;
  assert.equal(await runPostPlusSkillUpdate({ runCommand: async () => ({ stdout: JSON.stringify([{ name: 'demo', path: f.installed, scope: 'global', agents: [], directories }]), stderr: '' }), runInteractiveCommand: async () => { writes++; await cp(f.skill, f.installed, { recursive: true }); return 0; } }, { scope: 'global', yes: true }), 0);
  assert.equal(writes, 1);
  const [backup] = await readdir(join(f.root, 'config/skill-backups'));
  const manifest = JSON.parse(await readFile(join(f.root, 'config/skill-backups', backup!, 'manifest.json'), 'utf8'));
  assert.equal(manifest.skills.length, 1);
  assert.equal(await readFile(join(manifest.skills[0].backupPath, 'SKILL.md'), 'utf8'), 'User-owned content');
});


test('unsupported installed content is preserved and never reported as a damaged CLI bundle', async (t) => {
  const f = await setup(t);
  await cp(f.skill, f.installed, { recursive: true });
  const linkedFile = join(f.installed, 'user-link');
  await symlink(join(f.installed, 'SKILL.md'), linkedFile);
  let mutations = 0;
  const deps = {
    runCommand: async () => ({ stdout: serializeInstallerEntries([{ name: 'demo', path: f.installed, scope: 'global', agents: labels }]), stderr: '' }),
    runInteractiveCommand: async () => { mutations++; return 0; },
    isInteractive: () => false,
  };
  for (const yes of [false, true]) {
    await assert.rejects(runPostPlusSkillUpdate(deps, { scope: 'global', yes }), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'postplus_skills_directory_unreadable');
      assert.ok((error as Error).message.includes(linkedFile));
      assert.match((error as { action: string }).action, /Move the symbolic link or special file/);
      assert.doesNotMatch((error as { action: string }).action, /Reinstall/);
      return true;
    });
  }
  assert.equal(mutations, 0);
  const { lstat } = await import('node:fs/promises');
  assert.equal((await lstat(linkedFile)).isSymbolicLink(), true);
  assert.equal(await readFile(linkedFile, 'utf8'), await readFile(join(f.skill, 'SKILL.md'), 'utf8'));
});
