import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HostedProductRequestError,
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
