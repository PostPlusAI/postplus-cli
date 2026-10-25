import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('independent CLI processes share original staging and retain unrelated cache entries', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'postplus-staging-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'product.png');
  await writeFile(file, 'product bytes');
  const moduleUrl = new URL('./hosted-media-input.ts', import.meta.url).href;
  const script = `
    import { appendFile } from 'node:fs/promises';
    import { setTimeout } from 'node:timers/promises';
    import { resolveManifestMediaInputs } from ${JSON.stringify(moduleUrl)};
    const result = await resolveManifestMediaInputs({ endpointKey: 'fixture',
      fields: [{name:'images',type:'media-url',mediaKind:'image',class:'intent'}],
      request:{images:[process.env.FIXTURE_FILE]}, stage:async({operationId,file})=>{
        await appendFile(process.env.FIXTURE_CALLS, JSON.stringify({operationId,sha:file.contentSha256})+'\\n');
        if(process.env.FIXTURE_CRASH==='1') process.exit(7);
        await setTimeout(150);
        return 'postplus-media://uploads/fixture/'+file.contentSha256+'.png';
      }}); console.log(JSON.stringify(result));`;
  const run = (source: string, crash = false) => new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, POSTPLUS_CONFIG_DIR: path.join(root, 'config'), FIXTURE_FILE: source, FIXTURE_CALLS: path.join(root, 'calls'), FIXTURE_CRASH: crash ? '1' : '0' },
    });
    let out = '', err = '';
    child.stdout.on('data', (data) => { out += String(data); });
    child.stderr.on('data', (data) => { err += String(data); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 || (crash && code === 7) ? resolve({ code, out }) : reject(Error(err)));
  });
  const results = await Promise.all([run(file), run(file)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await readFile(path.join(root, 'calls'), 'utf8')).trim().split('\n').length, 1);
  const sources = [path.join(root, 'a.png'), path.join(root, 'b.png')];
  await Promise.all(sources.map((source) => writeFile(source, source)));
  await Promise.all(sources.map((source) => run(source)));
  const cache = JSON.parse(await readFile(path.join(root, 'config/media-staging-cache.json'), 'utf8'));
  assert.equal(Object.keys(cache.entries).length, 3);
  const interrupted = path.join(root, 'crash.png');
  await writeFile(interrupted, 'interrupted bytes');
  assert.equal((await run(interrupted, true)).code, 7);
  assert.equal((await run(interrupted)).code, 0);
  assert.equal((await readFile(path.join(root, 'calls'), 'utf8')).trim().split('\n').length, 5);
});
