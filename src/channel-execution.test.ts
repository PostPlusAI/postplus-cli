import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pollHostedRunUntilSettled } from './hosted-command-runtime.js';

test('channel unknown stops waiting without pretending top-level processing is terminal', async () => {
  let polls = 0;
  const payload = {
    status: 'processing',
    operationId: 'original',
    execution: {
      resultStatus: 'unknown',
      nextAction: 'check',
      automaticRetryAllowed: false,
    },
  };
  const result = await pollHostedRunUntilSettled({
    pollIntervalMs: 1,
    waitBudgetMs: 1000,
    pollOnce: async () => {
      polls++;
      return payload;
    },
    readStatus: () => 'processing',
    stopWaiting: (value) =>
      (value as typeof payload).execution.resultStatus === 'unknown',
  });
  assert.deepEqual(result, payload);
  assert.equal(polls, 1);
});
