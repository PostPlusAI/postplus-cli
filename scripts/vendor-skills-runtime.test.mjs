import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = resolve(process.env.POSTPLUS_TEST_INSTALLER_ENTRY || join(root, 'vendor/skills-runtime/cli.mjs'));
const agents = ['claude-code','codex','cursor','github-copilot','windsurf','trae','trae-cn','openclaw','hermes-agent'];
async function snapshot(directory, results = {}) {
  for (const name of await readdir(directory)) {
    const full = join(directory, name); const info = await lstat(full);
    results[full] = [info.mode, info.mtimeMs, info.isSymbolicLink() ? await readlink(full) : info.isFile() ? createHash('sha256').update(await readFile(full)).digest('hex') : null];
    if (info.isDirectory()) await snapshot(full, results);
  }
  return results;
}
for (const scope of ['global','project']) for (const mode of ['copy','symlink']) test(`local bundled installer ${scope}/${mode}: exact directories, edits, missing targets, read-only`, async (t) => {
  const temp = await mkdtemp(join(root, '.vendor-acceptance-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp,'home'); const cwd = join(temp,'project'); const fixture = join(temp,'fixture','demo');
  for (const dir of [home,cwd,fixture]) await mkdir(dir,{recursive:true});
  const content = '---\nname: demo\ndescription: Local ABI test.\n---\nOriginal\n';
  await writeFile(join(fixture,'SKILL.md'),content);
  const preload = join(temp,'deny-network.mjs');
  const network = join(temp,'network-attempt');
  await writeFile(preload, `import {writeFileSync} from 'node:fs'; import http from 'node:http'; import https from 'node:https'; import {syncBuiltinESMExports} from 'node:module'; const deny=()=>{writeFileSync(${JSON.stringify(network)},'attempt');throw new Error('network prohibited')};globalThis.fetch=deny;http.request=deny;https.request=deny;http.get=deny;https.get=deny;syncBuiltinESMExports();`);
  const env = { PATH: process.platform === 'win32' ? process.env.SystemRoot : '/usr/bin:/bin', HOME:home, USERPROFILE:home, XDG_CONFIG_HOME:join(home,'.config'), XDG_DATA_HOME:join(home,'.local/share'), XDG_CACHE_HOME:join(home,'.cache'), XDG_STATE_HOME:join(home,'.local/state'), CODEX_HOME:join(home,'.codex'), CLAUDE_CONFIG_DIR:join(home,'.claude'), HERMES_HOME:join(home,'.hermes'), APPDATA:join(home,'appdata'), DISABLE_TELEMETRY:'1', DO_NOT_TRACK:'1', CI:'1' };
  const run = (args) => JSON.parse(execFileSync(process.execPath,['--import',preload,cli,...args,...(scope==='global'?['--global']:[])],{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  run(['add',fixture,'--skill','demo','--agent',...agents,'--yes','--json',...(mode==='copy'?['--copy']:[])]);
  async function inspect() {
    const before = await snapshot(home); await snapshot(cwd,before);
    const rows = run(['list','--json','--agent',...agents]);
    const after = await snapshot(home); await snapshot(cwd,after); assert.deepEqual(after,before);
    return rows.flatMap((row)=>row.directories).filter((entry)=>entry.directoryName==='demo');
  }
  let entries = await inspect(); assert.deepEqual(new Set(entries.flatMap(e=>e.agentIds)),new Set(agents));
  const windsurf = entries.find(e=>e.agentIds.includes('windsurf'));
  await rm(windsurf.path,{recursive:true,force:true});
  entries=await inspect();assert.ok(!entries.some(e=>e.agentIds.includes('windsurf')),'canonical must not vouch for missing independent target');
  const claude=entries.find(e=>e.agentIds.includes('claude-code'));
  if (mode==='copy') {
    for (const [bytes,error,metadataName] of [[content.replace('name: demo','name: renamed'),'unused','renamed'],['not skill frontmatter','invalid-skill-metadata',null]]) {
      await writeFile(join(claude.path,'SKILL.md'),bytes);const changed=(await inspect()).find(e=>e.path===claude.path);
      assert.equal(changed.metadataName,metadataName);assert.equal(changed.metadataError,error==='unused'?null:error);
    }
    await rm(join(claude.path,'SKILL.md'));assert.equal((await inspect()).find(e=>e.path===claude.path).metadataError,'missing-skill-file');
  }
  await writeFile(windsurf.path,'occupied local file');assert.equal((await inspect()).find(e=>e.path===windsurf.path).metadataError,'occupied-file');
  await rm(windsurf.path);await symlink(join(temp,'missing-target'),windsurf.path);
  const dangling=(await inspect()).find(e=>e.path===windsurf.path);assert.equal(dangling.metadataError,'dangling-link');assert.equal(dangling.realPath,null);
  if(scope==='project') {
    await mkdir(join(cwd,'agent/subagents/reviewer'),{recursive:true});
    const [receipt]=run(['add',fixture,'--agent','eve','--subagent','reviewer','--yes','--copy','--json']);
    const dirs=run(['list','--json']).flatMap(r=>r.directories);assert.ok(dirs.some(e=>e.path===receipt.path&&e.agentIds.includes('eve')),'enumeration must cover Eve remove scope');
  }
  await assert.rejects(readFile(network),{code:'ENOENT'});
});

// A synchronous reader drains immediately and can hide process.exit truncation.
async function readSlowChild(t, args, cwd, env) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const closed = once(child, 'close');
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdout.pause();
  child.stderr.pause();
  const resume = setTimeout(() => { child.stdout.resume(); child.stderr.resume(); }, 250);
  t.after(() => clearTimeout(resume));
  const [code, signal] = await closed;
  assert.equal(signal, null);
  return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}

test('large list JSON survives a slow pipe reader', { timeout: 15000 }, async (t) => {
  const temp = await mkdtemp(join(root, '.vendor-acceptance-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'home');
  const cwd = join(temp, 'project');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const names = Array.from({ length: 400 }, (_, index) => `pipe-skill-${String(index).padStart(4, '0')}`);
  for (const name of names) {
    const directory = join(home, '.agents/skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Slow output regression fixture.\n---\n`);
  }
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'), CODEX_HOME: join(home, '.codex'),
    DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', CI: '1' };
  const result = await readSlowChild(t, ['list', '--global', '--json', '--agent', 'codex'], cwd, env);
  assert.equal(result.code, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.deepEqual(rows.map((row) => row.name).sort(), names);
  assert.ok(Buffer.byteLength(result.stdout) > 65536, 'fixture must exceed pipe capacity');
  assert.equal(result.stderr, '');
});

test('a command failure retains its status after draining output', { timeout: 15000 }, async (t) => {
  const result = await readSlowChild(t, ['postplus-unknown-command'], root, {
    ...process.env, DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', CI: '1',
  });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Unknown command: postplus-unknown-command/);
});
