import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AuthedCloudRequestInput } from './authed-cloud-request.js';
import {
  HostedAdsRequestError,
  runHostedAdsCommand,
} from './hosted-ads-commands.js';

const AUTH = {
  apiBaseUrl: 'https://postplus.example',
  cliSessionToken: 'session-secret',
};
const RELEASE_ID = 'skills-test-release';
const FIRST_BINDING = '11111111-1111-4111-8111-111111111111';
const SECOND_BINDING = '22222222-2222-4222-8222-222222222222';

describe('read-only Ads CLI', () => {
  it('builds the exact Google current-scope performance request', async () => {
    const requests: AuthedCloudRequestInput[] = [];
    const result = await runHostedAdsCommand(
      [
        'performance',
        '--provider',
        'google',
        '--scope',
        'current',
        '--date-from',
        '2026-08-01',
        '--date-to',
        '2026-08-07',
        '--json',
      ],
      { auth: AUTH, skillsReleaseId: RELEASE_ID },
      dependencies(requests),
    );

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(requests, [
      {
        auth: AUTH,
        body: {
          parameters: { dateFrom: '2026-08-01', dateTo: '2026-08-07' },
          queryId: 'google_ads.campaign.performance_daily.v1',
          scope: { type: 'current' },
        },
        method: 'POST',
        pathName: '/api/postplus-cli/hosted/ads/google/query-batch',
        skillsReleaseId: RELEASE_ID,
        timeoutMs: 45_000,
      },
    ]);
  });

  it('builds an exact ordered Meta selected-scope request', async () => {
    const requests: AuthedCloudRequestInput[] = [];
    await runHostedAdsCommand(
      [
        'performance',
        '--provider',
        'meta_ads',
        '--scope',
        'selected',
        '--binding-id',
        SECOND_BINDING,
        '--binding-id',
        FIRST_BINDING,
        '--json',
      ],
      { auth: AUTH, skillsReleaseId: RELEASE_ID },
      dependencies(requests),
    );

    assert.deepEqual(requests[0]?.body, {
      parameters: {},
      queryId: 'meta_ads.insights.account_daily.v1',
      scope: {
        bindingIds: [SECOND_BINDING, FIRST_BINDING],
        type: 'selected',
      },
    });
  });

  it('fast-fails invalid scope and provider-specific date input before auth or fetch', async () => {
    let touches = 0;
    const overrides = {
      resolveAuth: async () => {
        touches += 1;
        return AUTH;
      },
      sendRequest: async () => {
        touches += 1;
        return new Response('{}');
      },
      writeJson() {},
    };
    await assert.rejects(
      () =>
        runHostedAdsCommand(
          [
            'performance',
            '--provider',
            'google',
            '--scope',
            'current',
            '--date-from',
            '2026-08-01',
            '--date-to',
            '2026-09-01',
            '--json',
          ],
          undefined,
          overrides,
        ),
      /inclusive 1–31 day/u,
    );
    await assert.rejects(
      () =>
        runHostedAdsCommand(
          [
            'performance',
            '--provider',
            'google',
            '--scope',
            'selected',
            '--date-from',
            '2026-08-01',
            '--date-to',
            '2026-08-07',
            '--json',
          ],
          undefined,
          overrides,
        ),
      /Selected scope requires 1–10/u,
    );
    await assert.rejects(
      () =>
        runHostedAdsCommand(
          [
            'performance',
            '--provider',
            'meta_ads',
            '--scope',
            'current',
            '--date-from',
            '2026-08-01',
            '--json',
          ],
          undefined,
          overrides,
        ),
      /fixed to yesterday/u,
    );
    assert.equal(touches, 0);
  });

  it('refreshes bin auth once and returns a stable failure envelope', async () => {
    let authCalls = 0;
    const writes: unknown[] = [];
    const result = await runHostedAdsCommand(
      [
        'performance',
        '--provider',
        'meta_ads',
        '--scope',
        'all-linked',
        '--json',
      ],
      undefined,
      {
        async resolveAuth() {
          authCalls += 1;
          return { ...AUTH, cliSessionToken: `session-${authCalls}` };
        },
        async sendRequest(input) {
          await input.retryOn401?.();
          return failureResponse();
        },
        writeJson(value) {
          writes.push(value);
        },
      },
    );
    assert.equal(result, 1);
    assert.equal(authCalls, 2);
    assert.equal(
      (writes[0] as { error: { code: string } }).error.code,
      'scope_failed',
    );
  });

  it('throws the structured Ads failure in-process and rejects token reflection', async () => {
    await assert.rejects(
      () =>
        runHostedAdsCommand(
          [
            'performance',
            '--provider',
            'meta_ads',
            '--scope',
            'current',
            '--json',
          ],
          { auth: AUTH, skillsReleaseId: RELEASE_ID },
          {
            ...dependencies([]),
            sendRequest: async () => failureResponse(),
          },
        ),
      (error: unknown) =>
        error instanceof HostedAdsRequestError &&
        error.failure.code === 'scope_failed',
    );
    await assert.rejects(
      () =>
        runHostedAdsCommand(
          [
            'performance',
            '--provider',
            'meta_ads',
            '--scope',
            'current',
            '--json',
          ],
          { auth: AUTH, skillsReleaseId: RELEASE_ID },
          {
            ...dependencies([]),
            sendRequest: async () =>
              new Response(
                JSON.stringify({ ok: true, token: AUTH.cliSessionToken }),
              ),
          },
        ),
      /unsafe Ads response/u,
    );
  });
});

function dependencies(requests: AuthedCloudRequestInput[]) {
  return {
    resolveAuth: async () => AUTH,
    async sendRequest(input: AuthedCloudRequestInput) {
      requests.push(input);
      return new Response(JSON.stringify({ ok: true }));
    },
    writeJson() {},
  };
}

function failureResponse() {
  return new Response(
    JSON.stringify({
      error: {
        code: 'scope_failed',
        message: 'The requested account scope is unavailable.',
        retryable: false,
        status: 409,
      },
      namespace: 'ads',
      ok: false,
      requestId: '33333333-3333-4333-8333-333333333333',
      schemaVersion: 1,
    }),
    { status: 409 },
  );
}
