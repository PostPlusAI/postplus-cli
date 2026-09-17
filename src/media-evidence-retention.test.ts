import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectExpiredMediaEvidence, MEDIA_EVIDENCE_RETENTION_MS as TTL, withMediaEvidence } from './media-evidence-retention.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'postplus-retention-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = 'a'.repeat(64);
  const cache = path.join(root, 'media-evidence', key);
  const checkpoint = path.join(root, 'media-runs', `${key}.json`);
  await mkdir(path.dirname(checkpoint), { recursive: true });
  await writeFile(checkpoint, JSON.stringify({ schemaVersion: 1, handle: 'original-run' }));
  const state = path.join(root, 'media-evidence-retention', key, 'state.json');
  let now = 1000;
  const options = { root, now: () => now };
  const create = async () => { await mkdir(cache, { recursive: true }); await writeFile(path.join(cache, 'video.mp4'), 'cached video'); };
  const finish = () => withMediaEvidence(checkpoint, async (terminal) => { await create(); terminal(); }, options);
  return { root, key, cache, checkpoint, state, options, create, finish, setNow: (value: number) => { now = value; } };
}

test('only terminal managed evidence expires at 30 days; identity, outputs and backups remain', async (t) => {
  const f = await fixture(t);
  for (const name of ['media-runs', 'media-transfers', 'skill-backups', 'user-output']) {
    await mkdir(path.join(f.root, name), { recursive: true });
    await writeFile(path.join(f.root, name, 'keep'), 'keep');
  }
  await f.finish();
  assert.equal(await collectExpiredMediaEvidence(f.root, 1000 + TTL - 1), 0);
  assert.equal(await collectExpiredMediaEvidence(f.root, 1000 + TTL), 1);
  await assert.rejects(readdir(f.cache), { code: 'ENOENT' });
  for (const name of ['media-runs', 'media-transfers', 'skill-backups', 'user-output']) assert.equal(await readFile(path.join(f.root, name, 'keep'), 'utf8'), 'keep');
});

test('unfinished, legacy and corrupt records are retained regardless of age', async (t) => {
  const f = await fixture(t);
  await withMediaEvidence(f.checkpoint, f.create, f.options);
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 5), 0);
  await writeFile(f.state, '{bad');
  await withMediaEvidence(f.checkpoint, async (terminal) => { terminal(); }, f.options);
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 5), 0);
  await rm(path.dirname(f.state), { recursive: true });
  await withMediaEvidence(f.checkpoint, async (terminal) => { terminal(); }, f.options);
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 5), 0);
  assert.equal(await readFile(path.join(f.cache, 'video.mp4'), 'utf8'), 'cached video');
});

test('using old evidence protects it before collecting and resets the 30 day window', async (t) => {
  const f = await fixture(t);
  await f.finish();
  f.setNow(TTL * 2);
  await withMediaEvidence(f.checkpoint, async (terminal) => {
    assert.equal(await readFile(path.join(f.cache, 'video.mp4'), 'utf8'), 'cached video');
    assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 4), 0);
    terminal();
  }, f.options);
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 3 - 1), 0);
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 3), 1);
});

test('a leftover activity lease retains evidence but does not prevent resuming the operation', async (t) => {
  const f = await fixture(t);
  await f.finish();
  await writeFile(path.join(path.dirname(f.state), 'active-crashed.json'), JSON.stringify({ pid: 99999999 }));
  await withMediaEvidence(f.checkpoint, async (terminal) => { terminal(); }, f.options);
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 4), 0);
});

test('modified bytes, extra user files and symbolic links never become deletion candidates', async (t) => {
  const f = await fixture(t);
  await f.finish();
  await writeFile(path.join(f.cache, 'video.mp4'), 'user replacement');
  await withMediaEvidence(f.checkpoint, async (terminal) => { terminal(); }, f.options);
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 4), 0);
  await writeFile(path.join(f.cache, 'notes.txt'), 'user notes');
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 4), 0);
  await rm(f.cache, { recursive: true });
  const external = path.join(f.root, 'external');
  await mkdir(external);
  await writeFile(path.join(external, 'video.mp4'), 'external');
  await symlink(external, f.cache, 'dir');
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 4), 0);
  assert.equal(await readFile(path.join(external, 'video.mp4'), 'utf8'), 'external');
});

test('an explicitly requested output inside the cache protects that directory', async (t) => {
  const f = await fixture(t);
  await withMediaEvidence(f.checkpoint, async (terminal) => { await f.create(); terminal(); }, { ...f.options, outputPath: path.join(f.cache, 'video.mp4') });
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 4), 0);
});

test('an exception releases this invocation lease but cannot mark unknown work terminal', async (t) => {
  const f = await fixture(t);
  await assert.rejects(withMediaEvidence(f.checkpoint, async () => { await f.create(); throw new Error('unknown response'); }, f.options), /unknown response/);
  assert.equal((await readdir(path.dirname(f.state))).some((name) => name.startsWith('active-')), false);
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 4), 0);
});

test('concurrent collection deletes an eligible cache once', async (t) => {
  const f = await fixture(t);
  await f.finish();
  const counts = await Promise.all([collectExpiredMediaEvidence(f.root, TTL * 4), collectExpiredMediaEvidence(f.root, TTL * 4)]);
  assert.equal(counts.reduce((a, b) => a + b, 0), 1);
});


test('unrelated busy and unknown gates are skipped without delaying the current operation', async (t) => {
  const f = await fixture(t);
  await f.finish();
  const lock = path.join(path.dirname(f.state), 'gate');
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner-00000000-0000-0000-0000-000000000000.json'), JSON.stringify({ pid: process.pid }));
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 4), 0);
  await rm(lock, { recursive: true });
  await mkdir(lock);
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 4), 0);
  assert.deepEqual(await readdir(lock), []);
  await writeFile(path.join(lock, 'unknown'), 'unreadable owner');
  const other = path.join(f.root, 'media-runs', `${'b'.repeat(64)}.json`);
  await writeFile(other, '{}');
  let executed = false;
  await withMediaEvidence(other, async () => { executed = true; }, { ...f.options, now: () => TTL * 4 });
  assert.equal(executed, true);
  assert.equal(await readFile(path.join(f.cache, 'video.mp4'), 'utf8'), 'cached video');
});

test('same-named external and symlink checkpoints cannot manage local evidence', async (t) => {
  const f = await fixture(t);
  await f.finish();
  const before = await readFile(f.state, 'utf8');
  const external = path.join(f.root, 'external');
  await mkdir(external);
  const other = path.join(external, `${f.key}.json`);
  await writeFile(other, '{}');
  for (const checkpoint of [other, path.join(f.root, 'media-runs', `${'b'.repeat(64)}.json`)]) {
    if (checkpoint !== other) await symlink(other, checkpoint);
    await withMediaEvidence(checkpoint, async (terminal) => { terminal(); }, { ...f.options, now: () => TTL * 4 });
  }
  assert.equal(await readFile(f.state, 'utf8'), before);
  assert.equal(await readFile(path.join(f.cache, 'video.mp4'), 'utf8'), 'cached video');
  assert.deepEqual(await readdir(path.dirname(path.dirname(f.state))), [f.key]);
});

test('after cache collection the saved original handle still polls without resubmission', async (t) => {
  const f = await fixture(t);
  await f.finish();
  const originalCheckpoint = await readFile(f.checkpoint, 'utf8');
  assert.equal(await collectExpiredMediaEvidence(f.root, TTL * 4), 1);
  const { pollVideoAnalysis } = await import('./media-video-command.js');
  const checkpoint = JSON.parse(await readFile(f.checkpoint, 'utf8'));
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    assert.equal(body.operation, 'status');
    assert.equal(body.handle, 'original-run');
    return Response.json({ output: { data: { id: 'original-run', status: 'completed', markdown: '# Original report' } } });
  });
  const result = await pollVideoAnalysis({
    handle: checkpoint.handle, checkpoint: null, outputPath: null, json: true, debug: false,
    wait: { pollIntervalMs: 1, waitBudgetMs: 0 },
    context: { auth: { apiBaseUrl: 'https://postplus.test', cliSessionToken: 'fixture-only' } },
  });
  assert.equal(result, '# Original report');
  assert.equal(requests.length, 1);
  assert.equal(await readFile(f.checkpoint, 'utf8'), originalCheckpoint);
  await assert.rejects(readdir(f.cache), { code: 'ENOENT' });
});
