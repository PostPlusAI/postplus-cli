import assert from 'node:assert/strict';
import test from 'node:test';
import { toFailureFact } from './failure-contract.js';

test('pre-dispatch staging failure retains typed operation, retry and next action in outer JSON', () => {
  const failure = toFailureFact(new HostedProductRequestError({ code: 'postplus_cli_hosted_storage_upload_pending', layer: 'hosted_storage_invalid_request', message: 'Original upload pending.', operationId: 'original-upload', userMessageRule: 'generic_retry', retryable: true, userAction: 'Verify the original upload; do not replace it.' }, 409));
  assert.equal(failure.code, 'postplus_cli_hosted_storage_upload_pending');
  assert.equal(failure.correlationId, 'original-upload');
  assert.equal(failure.operationId, 'original-upload');
  assert.equal(failure.httpStatus, 409);
  assert.equal(failure.retryable, true);
  assert.equal(failure.action, 'Verify the original upload; do not replace it.');
});

import {
  HostedProductRequestError,
  dispatchHostedCommand,
  assertSuccessfulMediaTerminal,
  readMediaRunResult,
  isHostedRunSettled,
  pollHostedRunUntilSettled,
} from './hosted-command-runtime.js';

for (const stage of ['analyzing', undefined]) {
  test(`terminal output uses only the authoritative run stage: ${stage ?? 'missing'}`, () => {
    const payload = { output: { data: {
      id: 'original-run', status: 'failed', stage,
      progress: { stage: 'completed', bytes: 12 },
      error: { code: 'provider_unknown', stage: 'resolving_source', retryable: false },
    } } };
    const run = readMediaRunResult(payload);
    assert.equal(run.stage, stage ?? null);
    assert.equal(run.bytes, 12);
    assert.throws(() => assertSuccessfulMediaTerminal(payload), (error: unknown) => {
      assert.ok(error instanceof HostedProductRequestError);
      assert.equal(error.productError.stage, stage ?? 'unknown');
      assert.equal(error.productError.runId, 'original-run');
      assert.equal(error.productError.retryable, false);
      return true;
    });
  });
}

test('terminal media preserves the validated account action without making unsafe URLs actionable', () => {
  for (const url of ['https://postplus.test/home/account-1/billing', 'javascript:alert(1)']) {
    const action = { type: 'open_url', label: 'Add PostPlus credits', url };
    const payload = { output: { data: {
      id: 'original-run', status: 'failed', stage: 'analyzing',
      error: { code: 'balance_required', userAction: action },
    } } };
    assert.throws(() => assertSuccessfulMediaTerminal(payload), (error: unknown) => {
      assert.ok(error instanceof HostedProductRequestError);
      if (url.startsWith('https:')) {
        assert.deepEqual(error.productError.userAction, action);
        assert.ok(error.message.includes(`Add PostPlus credits: ${url}`));
      } else {
        assert.ok(!error.message.includes('javascript:'));
        assert.match(error.message, /do not resubmit/);
      }
      return true;
    });
  }
});


test('subscription guidance keeps the billing link readable and diagnostics structured', () => {
  for (const code of ['subscription_required', 'postplus_cli_subscription_required']) {
    const productError = { code, message: 'This feature is included with a paid PostPlus subscription.', layer: 'subscription', operationId: 'op-1', userMessageRule: 'subscription_action', retryable: false, userAction: { type: 'open_url' as const, label: 'View plans', url: 'https://postplus.test/home/workspace/billing' } };
    const error = new HostedProductRequestError(productError, 403);
    assert.match(error.message, /https:\/\/postplus.test\/home\/workspace\/billing/);
    assert.match(error.message, /resume that task instead/);
    assert.doesNotMatch(error.message, /code=|layer=|retryable=/);
    assert.equal(error.productError.code, code);
    assert.equal(error.productError.retryable, false);
  }
});


test('subscription rejection is friendly in text and remains actionable in JSON', async () => {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  try {
    for (const json of [false, true]) {
      let out = ''; let diagnostic = '';
      process.stdout.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof stdout;
      process.stderr.write = ((chunk: unknown) => { diagnostic += String(chunk); return true; }) as typeof stderr;
      const exit = await dispatchHostedCommand({ json, outputPath: null, errorInputLabel: 'research', request: async () => {
        throw new HostedProductRequestError({ code: 'postplus_cli_subscription_required', message: 'Research is included with PostPlus Plus and Pro.', layer: 'subscription', operationId: null, userMessageRule: 'subscription_action', retryable: false, userAction: { type: 'open_url', label: 'View plans', url: 'https://postplus.test/home/workspace/billing' } }, 402);
      } }, undefined);
      assert.equal(exit, 1);
      assert.match(diagnostic, /View plans: https:\/\/postplus.test/);
      assert.doesNotMatch(diagnostic, /code=|layer=/);
      if (json) {
        const error = JSON.parse(out).error;
        assert.equal(error.code, 'postplus_cli_subscription_required');
        assert.equal(error.retryable, false);
        assert.equal(error.userAction.url, 'https://postplus.test/home/workspace/billing');
      } else assert.equal(out, '');
    }
  } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
});

test('channel provider diagnosis survives product error parsing without private fields', async () => {
  const { readHostedProductError } = await import('./hosted-command-runtime.js');
  const error = readHostedProductError({
    code: 'provider_unavailable', stage: 'channel_connection',
    diagnostic: { service: 'composio', code: 'http', httpStatus: 403, providerLogId: 'log_fixture', token: 'private' },
  });
  assert.deepEqual(error.diagnostic, { service: 'composio', code: 'http', httpStatus: 403, providerLogId: 'log_fixture' });
  assert.match(new HostedProductRequestError(error).message, /providerHttpStatus=403/);
  assert.ok(!JSON.stringify(error).includes('private'));
});

test('short research polling observes completion inside a budget shorter than the regular interval', async () => {
  const { pollHostedRunUntilSettled } = await import('./hosted-command-runtime.js');
  let calls = 0;
  const result = await pollHostedRunUntilSettled({
    pollIntervalMs: 200,
    initialPollIntervalMs: 1,
    waitBudgetMs: 100,
    pollOnce: async () => ({ status: ++calls === 1 ? 'processing' : 'completed' }),
    readStatus: (value) => (value as { status: string }).status,
  });
  assert.deepEqual(result, { status: 'completed' });
  assert.equal(calls, 2);
});

test('terminal research waits for explicit settlement at either hosted response boundary', async () => {
  for (const status of ['completed', 'failed', 'canceled']) {
    for (const nested of [false, true]) {
      let calls = 0;
      const record = {
        status,
        settlement_pending: true,
        error: status === 'completed' ? null : { code: 'original_failure', message: 'Original failure reason' },
        summary: { raw_records: 1, unique_ads: 1 },
      };
      const result = await pollHostedRunUntilSettled({
        pollIntervalMs: 1,
        waitBudgetMs: 100,
        pollOnce: async () => {
          calls++;
          const output = { ...record, settlement_pending: calls < 3 };
          return nested ? { output } : output;
        },
        readStatus: (payload) => nested ? (payload as { output: { status: string } }).output.status : (payload as { status: string }).status,
      });
      assert.equal(calls, 3);
      const settled = { ...record, settlement_pending: false };
      assert.deepEqual(result, nested ? { output: settled } : settled);
    }
  }
});

test('single check preserves pending settlement and settled business outcomes finish immediately', async () => {
  let calls = 0;
  const pending = { status: 'failed', settlement_pending: true, error: { message: 'Original provider failure' } };
  const result = await pollHostedRunUntilSettled({
    pollIntervalMs: 100,
    waitBudgetMs: 0,
    pollOnce: async () => { calls++; return pending; },
    readStatus: (value) => (value as { status: string }).status,
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, pending);
  assert.equal(isHostedRunSettled(pending, pending.status), false);
  for (const settlement_pending of [false, undefined]) {
    assert.equal(isHostedRunSettled({ status: 'completed', settlement_pending }, 'completed'), true);
  }
  assert.equal(isHostedRunSettled({ settlement_pending: false }, 'processing'), false);
});


test('terminal media preserves the actual sanitized cause, cost facts and original identity', () => {
  const payload = { operationId: 'original-operation', billing: { credits: 0, status: 'released', providerCostUsd: 10 }, output: { data: {
    id: 'original-run', status: 'failed', error: { code: 'invalid_request', message: 'Video input https://cdn.example.com/a.mp4?secret=private failed validation', retryable: false, submissionOutcome: 'rejected' },
  } } };
  assert.throws(() => assertSuccessfulMediaTerminal(payload), (error: unknown) => {
    assert.ok(error instanceof HostedProductRequestError);
    assert.match(error.productError.message, /failed validation/);
    assert.ok(!error.productError.message.includes('secret'));
    assert.equal(error.productError.operationId, 'original-operation');
    assert.equal(error.productError.submissionOutcome, 'rejected');
    assert.deepEqual(error.productError.billing, { credits: 0, status: 'released' });
    return true;
  });
});


test('pre-dispatch failure preserves distinct request and operation identities', () => {
  const failure = toFailureFact(new HostedProductRequestError({
    code: 'upload_failed', layer: 'hosted_storage_invalid_request', message: 'Upload failed.',
    correlationId: 'request-original', operationId: 'operation-original',
    userMessageRule: 'generic_retry', retryable: true,
  }, 503));
  assert.equal(failure.correlationId, 'request-original');
  assert.equal(failure.operationId, 'operation-original');
  assert.equal(failure.httpStatus, 503);
});
