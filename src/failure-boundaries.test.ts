import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, test } from 'node:test';
import { fetchHostedBalance, fetchHostedRunDetail, fetchHostedRunsList } from './hosted-account-commands.js';
import { refreshRemoteAuthSession } from './auth-session.js';
import { validateRemoteAuth } from './auth-validate.js';
import { revokeRemoteAuth } from './auth-lifecycle.js';
import { validateCliSession } from './auth-login.js';
import { setLocalSession } from './local-state.js';
import { formatFailure, toFailureFact } from './failure-contract.js';
import { HostedProductRequestError, postHostedJson } from './hosted-command-runtime.js';

let directory: string;
let originalConfig: string | undefined;
let originalFetch: typeof fetch;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'postplus-failure-boundary-'));
  originalConfig = process.env.POSTPLUS_CONFIG_DIR;
  process.env.POSTPLUS_CONFIG_DIR = directory;
  originalFetch = globalThis.fetch;
  await setLocalSession({ accountId: 'account', apiBaseUrl: 'https://postplus.test', cliSessionToken: 'fixture-session', sessionExpiresAt: null, userEmail: null, userId: 'user' });
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalConfig === undefined) delete process.env.POSTPLUS_CONFIG_DIR;
  else process.env.POSTPLUS_CONFIG_DIR = originalConfig;
  await rm(directory, { recursive: true, force: true });
});
const auth = { apiBaseUrl: 'https://postplus.test', cliSessionToken: 'fixture-session' };
const actions = [
  () => fetchHostedBalance(),
  () => fetchHostedRunDetail('run-original'),
  () => fetchHostedRunsList({ status: null, since: null, limit: null, json: true }),
  () => refreshRemoteAuthSession(),
  () => validateRemoteAuth(),
  () => revokeRemoteAuth(),
  () => validateCliSession(auth),
];
test('account and auth failures retain structured facts, correlation and safe nested causes without changing session', async () => {
  const before = await readFile(path.join(directory, 'config.json'), 'utf8');
  globalThis.fetch = async () => Response.json({ error: {
    code: 'service_busy', message: 'Read failed token=secret-value', stage: 'read-status', service: 'postplus-cloud',
    retryable: true, action: 'Check the original task.', operationId: 'op-original', checkpointId: 'checkpoint-original',
    cause: [{ name: 'Error', code: 'ETIMEDOUT', message: 'timeout https://private.test/a?signature=secret-value Cookie: session=private-cookie' }],
    payload: 'private-payload', stack: 'private-stack',
  } }, { status: 503, headers: { 'x-request-id': 'request-original' } });
  for (const action of actions) {
    await assert.rejects(action, error => {
      const fact = toFailureFact(error);
      assert.equal(fact.code, 'service_busy');
      assert.equal(fact.stage, 'read-status');
      assert.equal(fact.retryable, true);
      assert.equal(fact.action, 'Check the original task.');
      assert.equal(fact.httpStatus, 503);
      assert.equal(fact.correlationId, 'request-original');
      assert.equal(fact.operationId, 'op-original');
      assert.equal(fact.checkpointId, 'checkpoint-original');
      const human = formatFailure(fact);
      for (const expected of ['ETIMEDOUT', 'service_busy', 'read-status', '503', 'request-original', 'op-original']) assert.ok(human.includes(expected), human);
      assert.doesNotMatch(JSON.stringify(fact) + human, /secret-value|private-cookie|private-payload|private-stack/);
      return true;
    });
  }
  assert.equal(await readFile(path.join(directory, 'config.json'), 'utf8'), before);
});

test('account errors handle string, empty, invalid and unknown bodies while preserving HTTP evidence', async () => {
  for (const [body, message] of [
    ['{"error":"Service unavailable"}', 'Service unavailable'],
    ['"Service unavailable"', 'Service unavailable'],
    ['', 'no recognized error details'],
    ['{"unknown":"private-payload"}', 'no recognized error details'],
    ['<html>private-payload</html>', 'invalid JSON'],
    ['{"error":', 'invalid JSON'],
  ]) {
    globalThis.fetch = async () => new Response(body, { status: 502, headers: { 'x-correlation-id': 'request-body' } });
    await assert.rejects(fetchHostedBalance, error => {
      const fact = toFailureFact(error);
      assert.ok(fact.message.includes(message!), fact.message);
      assert.equal(fact.httpStatus, 502);
      assert.equal(fact.correlationId, 'request-body');
      assert.doesNotMatch(JSON.stringify(fact), /private-payload|<html>/);
      return true;
    });
  }
});

test('hosted product rejection retains response metadata and sanitized upstream action', async () => {
  globalThis.fetch = async () => Response.json({ error: { code: 'tool_unavailable', message: 'Read unavailable', stage: 'provider-read', retryable: false, sourceOperationId: 'source-original', cause: [{name: 'Error', code: 'ETIMEDOUT', message: 'timeout token=private-token'}], action: 'Inspect original operation token=private-token', operationId: 'op-original' } }, { status: 503, headers: { 'x-request-id': 'hosted-request' } });
  await assert.rejects(() => postHostedJson({ body: {}, pathName: '/api/postplus-cli/hosted/capability', skillName: null, context: { auth } }), error => {
    assert.ok(error instanceof HostedProductRequestError);
    assert.equal(error.productError.httpStatus, 503);
    assert.equal(error.productError.correlationId, 'hosted-request');
    assert.equal(error.productError.code, 'tool_unavailable');
    assert.equal(error.productError.retryable, false);
    assert.match(error.message, /hosted-request/);
    assert.match(error.message, /ETIMEDOUT/);
    assert.equal(error.productError.sourceOperationId, 'source-original');
    assert.doesNotMatch(JSON.stringify(error.productError) + error.message, /private-token/);
    return true;
  });
});

test('real CLI poll text and JSON preserve the original task and output without submitting again', async () => {
  const handle = 'run-$(printf injected)-`pwd`-$HOME';
  const output = path.join(directory, 'result.json');
  const trace = path.join(directory, 'trace.jsonl');
  await writeFile(output, '{"id":"run-original","status":"processing"}\n');
  const original = await readFile(output, 'utf8');
  const stub = `import {appendFileSync} from 'node:fs';
    globalThis.fetch=async(url,init)=>{
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify(JSON.parse(String(init.body)))+'\\n');
      throw new TypeError('fetch failed', {cause:Object.assign(new Error('getaddrinfo failed token=private-token https://private.test/a?sig=private-signature'), {code:'ENOTFOUND'})});
    };`;
  for (const json of [false, true]) {
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stub)}`, 'build/index.js', 'media', 'poll', '--handle', handle, '--wait-seconds', '0', '--output', output, ...(json ? ['--json'] : [])], { encoding: 'utf8', env: { ...process.env, POSTPLUS_CONFIG_DIR: directory }, timeout: 15_000 });
    assert.equal(result.status, 1, result.stderr);
    const view = result.stdout + result.stderr;
    assert.match(view, /ENOTFOUND/);
    assert.match(view, /media-poll/);
    assert.ok(view.includes(handle));
    if (!json) assert.ok(view.includes(`--handle '${handle}'`));
    assert.match(view, /do not resubmit/);
    assert.doesNotMatch(view, /private-token|private-signature/);
    if (json) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.ok, false);
      assert.equal(report.error.runId, handle);
      assert.ok(report.error.action.includes(`--handle '${handle}'`));
    }
    assert.equal(await readFile(output, 'utf8'), original);
  }
  const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(body => body.operation === 'status' && body.handle === handle && !body.input && !body.quoteConfirmationToken));
});

test('session validation retains its server-registration guidance and handles empty error bodies', async () => {
  globalThis.fetch = async () => Response.json({ code: 'postplus_cli_auth_not_initialized', error: 'Not registered' }, { status: 403 });
  await assert.rejects(() => validateCliSession(auth), error => {
    const fact = toFailureFact(error);
    assert.equal(fact.code, 'postplus_cli_auth_not_initialized');
    assert.equal(fact.httpStatus, 403);
    assert.match(fact.message, /Finish the PostPlus CLI server registration flow/);
    return true;
  });
  for (const body of [null, JSON.stringify('Service unavailable')]) {
    globalThis.fetch = async () => new Response(body, { status: 502 });
    await assert.rejects(() => validateCliSession(auth), error => {
      assert.equal(toFailureFact(error).httpStatus, 502);
      return true;
    });
  }
});

test('account correlation from the payload is retained when the response has no header', async () => {
  globalThis.fetch = async () => Response.json({ error: { code: 'read_failed', message: 'Read failed', correlationId: 'payload-correlation' } }, { status: 503 });
  await assert.rejects(fetchHostedBalance, error => {
    assert.equal(toFailureFact(error).correlationId, 'payload-correlation');
    return true;
  });
});
