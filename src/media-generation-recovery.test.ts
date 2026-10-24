import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runHostedDomainCommand } from './hosted-domain-commands.js';
import { setLocalSession } from './local-state.js';
import { prepareMediaRunCheckpoint } from './media-run-checkpoint.js';

async function setup(t: TestContext) {
  const previous = process.env.POSTPLUS_CONFIG_DIR;
  const root = await mkdtemp(path.join(tmpdir(), 'postplus-generation-recovery-'));
  process.env.POSTPLUS_CONFIG_DIR = root;
  await setLocalSession({ accountId: 'account-1', userId: 'user-1',
    cliSessionToken: 'private-session-token', sessionExpiresAt: null, apiBaseUrl: 'https://postplus.test' });
  const fetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.POSTPLUS_CONFIG_DIR;
    else process.env.POSTPLUS_CONFIG_DIR = previous;
    await rm(root, { force: true, recursive: true });
  });
  return root;
}
const absent = () => Response.json({ code: 'postplus_cli_hosted_async_run_not_found', message: 'No run.', retryable: false }, { status: 404 });
const completed = () => Response.json({ output: { data: { id: 'original-run', status: 'completed' } } });

for (const accepted of [false, true]) {
  test(`resume ${accepted ? 'reads an accepted request after lost acknowledgement' : 'continues the saved request after failed transport'} with its original identity`, async t => {
    const root = await setup(t);
    const output = path.join(root, 'result.json');
    const calls: Record<string, unknown>[] = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      if (calls.length === 1) {
        const files = await readdir(path.join(root, 'media-runs'));
        const saved = JSON.parse(await readFile(path.join(root, 'media-runs', files[0]!), 'utf8'));
        assert.deepEqual(saved.generationRequest.input, body.input);
        assert.equal(saved.generationSubmissionAttempted, true);
        assert.doesNotMatch(JSON.stringify(saved), /private-session-token/);
        throw new TypeError('fixture disconnected before acknowledgement');
      }
      assert.equal(body.operationId === calls[0]!.operationId || body.sourceOperationId === calls[0]!.operationId || body.handle === 'original-run', true);
      if (body.operation === 'status') return accepted ? completed() : absent();
      assert.deepEqual(body, calls[0]);
      return completed();
    };
    await assert.rejects(runHostedDomainCommand('media', ['create', 'image-gpt-image-2-text', '--prompt', 'original private prompt', '--output', output]), /fixture disconnected/);
    const files = await readdir(path.join(root, 'media-runs'));
    const pointer = path.join(root, 'media-runs', files[0]!);
    assert.equal(await runHostedDomainCommand('media', ['poll', '--resume-from', pointer, '--wait-seconds', '0', '--output', output]), 0);
    assert.equal(calls.filter(b => b.operation === 'request').length, accepted ? 1 : 2);
    const checkpoint = JSON.parse(await readFile(pointer, 'utf8'));
    assert.equal(checkpoint.handle, 'original-run');
    assert.equal(checkpoint.operationId, calls[0]!.operationId);
    // Later resumes use the accepted handle, even if an inconsistent lookup fails.
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.operation, 'status');
      assert.equal(body.handle, 'original-run');
      return absent();
    };
    assert.equal(await runHostedDomainCommand('media', ['poll', '--resume-from', pointer, '--wait-seconds', '0', '--output', output]), 1);
  });
}

for (const failure of ['legacy', 'wrong-account', 'malformed', 'network', 'server', 'untyped-404']) {
  test(`recovery never replays a ${failure} checkpoint/status failure`, async t => {
    const root = await setup(t);
    const prepared = await prepareMediaRunCheckpoint('media-generation', 'original-operation', null, undefined);
    assert.ok(prepared);
    const record = prepared.record;
    if (failure !== 'legacy') record.generationRequest = { endpointKey: 'image-gpt-image-2-text', input: { prompt: 'original' }, skillName: 'image-batch-runner' };
    if (failure === 'wrong-account') record.accountId = 'another-account';
    if (failure === 'malformed') (record.generationRequest as unknown as { input: unknown }).input = [];
    await writeFile(prepared.filePath, JSON.stringify(record));
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).operation, 'status');
      if (failure === 'network') throw new TypeError('fixture network failure');
      if (failure === 'server') return Response.json({ code: 'unavailable' }, { status: 503 });
      if (failure === 'untyped-404') return new Response('missing', { status: 404 });
      return absent();
    };
    const run = () => runHostedDomainCommand('media', ['poll', '--resume-from', prepared.filePath, '--wait-seconds', '0', '--output', path.join(root, 'result.json')]);
    if (['wrong-account', 'malformed', 'network'].includes(failure)) await assert.rejects(run());
    else assert.equal(await run(), 1);
    if (['wrong-account', 'malformed'].includes(failure)) assert.equal(calls, 0);
    else assert.equal(calls, 1);
  });
}
