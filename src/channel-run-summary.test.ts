import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type HostedRunDetail,
  formatHostedRunDetailReport,
  formatHostedRunsListReport,
} from './hosted-account-commands.js';

test('subscription channel run keeps result unknown visible without a credits charge', () => {
  const run: HostedRunDetail = {
    id: 'run_1',
    capability: 'marketing-channels',
    status: 'processing',
    execution: {
      resultStatus: 'unknown',
      nextAction: 'Inspect the original operation',
      automaticRetryAllowed: false,
    },
    billingMode: 'personal_subscription',
    target: 'campaign_1',
    createdAt: '2026-09-24T00:00:00Z',
    updatedAt: '2026-09-24T00:01:00Z',
    finalizedCredits: null,
    reservedCredits: null,
    hasError: false,
    operationId: 'operation_1',
    outputs: null,
    error: null,
    completedAt: null,
    failedAt: null,
    expiresAt: null,
  };
  const detail = formatHostedRunDetailReport(run);
  assert.match(detail, /Status: unknown/);
  assert.match(detail, /Billing: included in personal subscription/);
  assert.match(detail, /do not resubmit automatically/);
  assert.doesNotMatch(detail, /Still running|credits reserved/);

  const list = formatHostedRunsListReport({
    runs: [run],
    count: 1,
    filters: { status: null, since: null, limit: 20 },
  });
  assert.match(list, /\[unknown\]/);
  assert.match(list, /included in personal subscription/);
});
