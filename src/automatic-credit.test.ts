import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import { runHostedRequest } from './hosted-lib.js';
import { HostedProductRequestError } from './hosted-command-runtime.js';

const auth = { apiBaseUrl: 'https://postplus.test', cliSessionToken: 'test-session' };
const args = ['create', 'video-seedance-2-5-text', '--prompt', 'A cup on a table', '--hosted-operation-id', 'automatic-credit-test'];

test('paid request submits once without a confirmation token or a separate quote request', async (t) => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return Response.json({ output: { data: { id: 'accepted-run' } } });
  });
  const result = await runHostedRequest({ domain: 'media', args, auth });
  assert.deepEqual(result, { output: { data: { id: 'accepted-run' } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://postplus.test/api/postplus-cli/hosted/capability');
  assert.equal(calls[0]!.body.operationId, 'automatic-credit-test');
  assert.equal(Object.hasOwn(calls[0]!.body, 'quoteConfirmationToken'), false);
});

test('insufficient credits preserves the server error without confirming or retrying', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ code: 'insufficient_credits', message: 'Insufficient credits.', operationId: 'automatic-credit-test' }, { status: 402 });
  });
  await assert.rejects(runHostedRequest({ domain: 'media', args, auth }), (error: unknown) => {
    assert.ok(error instanceof HostedProductRequestError);
    assert.equal(error.productError.code, 'insufficient_credits');
    assert.equal(error.productError.operationId, 'automatic-credit-test');
    return true;
  });
  assert.equal(calls, 1);
});

test('removed confirmation flags fail before any request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  await assert.rejects(runHostedRequest({ domain: 'media', args: [...args, '--quote-confirmation-token', 'obsolete-token'], auth }), /Unknown option/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('removed quote confirm command fails with stdin closed instead of prompting', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['build/index.js', 'quote', 'confirm', '--json'], {
    timeout: 10000,
  }), (error: unknown) => {
    assert.equal(JSON.parse(String((error as { stdout?: string }).stdout)).error.code, 'postplus_unknown_command');
    return true;
  });
});
