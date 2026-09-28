import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HostedProductRequestError,
  dispatchHostedCommand,
  assertSuccessfulMediaTerminal,
  readMediaRunResult,
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
