import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { PostPlusClientUpgradeRequiredError } from './client-compatibility.js';
import {
  HostedCompatibilityRequestError,
  HostedProductRequestError,
} from './hosted-command-runtime.js';
import { setLocalSession, updateLocalConfig } from './local-state.js';
import { parseSseEvents, waitForMetaResearchViaSse } from './research-sse-stream.js';

function streamFromChunks(chunks: (Uint8Array | string | (() => never))[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const next = chunks[index++];
      if (typeof next === 'function') {
        next();
      }
      controller.enqueue(typeof next === 'string' ? encoder.encode(next) : next);
    },
  });
}

describe('research SSE parser & stream client', () => {
  const tempDirs: string[] = [];
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function setupLocalAuth() {
    const dir = await mkdtemp(join(tmpdir(), 'postplus-sse-test-'));
    tempDirs.push(dir);
    process.env.POSTPLUS_CONFIG_DIR = dir;
    process.env.POSTPLUS_STATE_DIR = dir;
    process.env.POSTPLUS_API_BASE_URL = 'https://postplus.test';
    await setLocalSession({
      accountId: 'acc-1',
      accountName: 'Test Account',
      apiBaseUrl: 'https://postplus.test',
      cliSessionToken: 'ppcli_initial_token',
      sessionExpiresAt: null,
      userEmail: 'test@example.com',
      userId: 'user-1',
    });
    await updateLocalConfig((current) => ({
      ...(current ?? {}),
      skillsBaseline: {
        schemaVersion: 1,
        releaseId: 'skills-test-release',
        installedAt: new Date().toISOString(),
        source: 'bundled',
        skills: [],
      },
    }));
  }

  it('parses chunk-split UTF-8, CRLF, comments, and multi-line data events', async () => {
    const emojiBytes = new TextEncoder().encode('🎉');
    const part1 = emojiBytes.slice(0, 2);
    const part2 = emojiBytes.slice(2);
    const stream = streamFromChunks([
      ': keepalive\r\n\r\nevent: status\r\n',
      'data: {"line":"one"}\r\ndata: {"emoji":"',
      part1,
      part2,
      '"}\r',
      '\n\r\nevent: result\ndata: {"ok":true}\n\n',
    ]);

    const events = [];
    for await (const evt of parseSseEvents(stream)) {
      events.push(evt);
    }

    assert.deepEqual(events, [
      { event: 'status', data: '{"line":"one"}\n{"emoji":"🎉"}' },
      { event: 'result', data: '{"ok":true}' },
    ]);
  });

  it('handles status checkpoints, reconnect loops, and final result delivery', async () => {
    const observed: unknown[] = [];
    const requests: unknown[] = [];
    let call = 0;

    globalThis.fetch = async (url, init) => {
      call += 1;
      assert.equal(
        String(url),
        'https://postplus.test/api/postplus-cli/hosted/research/stream',
      );
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('accept'), 'text/event-stream');
      requests.push(JSON.parse(String(init?.body)));

      if (call === 1) {
        return new Response(
          streamFromChunks([
            'event: status\ndata: {"routeKey":"facebook-ads-library","operationId":"op-1","status":"processing","results_ready":false}\n\n',
            ': keepalive\n\n',
            'event: reconnect\ndata: {"retryMs":0}\n\n',
          ]),
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          },
        );
      }

      return new Response(
        streamFromChunks([
          'event: result\ndata: {"routeKey":"facebook-ads-library","operationId":"op-1","status":"processing","results_ready":true,"output":{"items":[{"ad_archive_id":"1"}]}}\n\n',
        ]),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        },
      );
    };

    let fallbackCalled = false;
    const result = await waitForMetaResearchViaSse({
      context: {
        auth: {
          apiBaseUrl: 'https://postplus.test',
          cliSessionToken: 'token-1',
        },
        skillsReleaseId: 'skills-test',
      },
      fallbackPoll: async () => {
        fallbackCalled = true;
        return null;
      },
      getIdentity: () => ({ sourceOperationId: 'op-1' }),
      onPayload: async (payload) => {
        observed.push(payload);
      },
      waitBudgetMs: 120_000,
    });

    assert.equal(fallbackCalled, false);
    assert.equal(call, 2);
    assert.equal(observed.length, 2);
    assert.equal((result as { results_ready: boolean }).results_ready, true);
    assert.equal(
      (requests[0] as { waitMs: number }).waitMs <= 120_000,
      true,
    );
  });

  it('refreshes 401 once on bin path and does not fall back on 400/403/404 business errors or 426/503 compat', async () => {
    await setupLocalAuth();
    let fallbackCalls = 0;

    // 401 refresh then success
    let authCalls = 0;
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target.includes('/auth/')) {
        return Response.json({
          accountId: 'acc-1',
          accountName: 'Test Account',
          accountSlug: null,
          accountType: 'personal',
          cliSessionToken: 'ppcli_refreshed_token',
          sessionExpiresAt: null,
          subscriptionStatus: 'active',
          userEmail: 'test@example.com',
          userId: 'user-1',
        });
      }
      authCalls += 1;
      const headers = new Headers(init?.headers);
      if (authCalls === 1) {
        return Response.json(
          { code: 'postplus_cli_auth_invalid_session', message: 'Expired' },
          { status: 401 },
        );
      }
      assert.equal(
        headers.get('authorization'),
        'Bearer ppcli_refreshed_token',
      );
      return new Response(
        streamFromChunks([
          'event: result\ndata: {"routeKey":"facebook-ads-library","operationId":"op-1","results_ready":true}\n\n',
        ]),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    };

    const refreshedResult = await waitForMetaResearchViaSse({
      fallbackPoll: async () => {
        fallbackCalls += 1;
        return null;
      },
      getIdentity: () => ({ sourceOperationId: 'op-1' }),
      onPayload: async () => undefined,
      waitBudgetMs: 30_000,
    });
    assert.equal(
      (refreshedResult as { results_ready: boolean }).results_ready,
      true,
    );
    assert.equal(fallbackCalls, 0);

    // 426 upgrade required
    globalThis.fetch = async () =>
      Response.json(
        {
          code: 'postplus_client_upgrade_required',
          error: 'Upgrade required',
          compatibility: { upgrade: { command: 'postplus update' } },
        },
        { status: 426 },
      );
    await assert.rejects(
      () =>
        waitForMetaResearchViaSse({
          context: {
            auth: {
              apiBaseUrl: 'https://postplus.test',
              cliSessionToken: 't',
            },
            skillsReleaseId: 'r',
          },
          fallbackPoll: async () => {
            fallbackCalls += 1;
            return null;
          },
          getIdentity: () => ({ sourceOperationId: 'op-1' }),
          onPayload: async () => undefined,
          waitBudgetMs: 30_000,
        }),
      PostPlusClientUpgradeRequiredError,
    );

    // 503 release in progress compatibility error
    globalThis.fetch = async () =>
      Response.json(
        {
          code: 'postplus_cli_cloud_release_in_progress',
          error: 'Updating cloud',
        },
        { status: 503 },
      );
    await assert.rejects(
      () =>
        waitForMetaResearchViaSse({
          context: {
            auth: {
              apiBaseUrl: 'https://postplus.test',
              cliSessionToken: 't',
            },
            skillsReleaseId: 'r',
          },
          fallbackPoll: async () => {
            fallbackCalls += 1;
            return null;
          },
          getIdentity: () => ({ sourceOperationId: 'op-1' }),
          onPayload: async () => undefined,
          waitBudgetMs: 30_000,
        }),
      HostedCompatibilityRequestError,
    );

    // 403 and 404 business run_not_found never fall back
    for (const [status, code] of [
      [403, 'postplus_cli_workspace_access_denied'],
      [404, 'postplus_cli_hosted_async_run_not_found'],
      [400, 'postplus_cli_hosted_apify_run_handle_invalid'],
    ] as const) {
      globalThis.fetch = async () =>
        Response.json({ code, message: 'Business error' }, { status });
      await assert.rejects(
        () =>
          waitForMetaResearchViaSse({
            context: {
              auth: {
                apiBaseUrl: 'https://postplus.test',
                cliSessionToken: 't',
              },
              skillsReleaseId: 'r',
            },
            fallbackPoll: async () => {
              fallbackCalls += 1;
              return null;
            },
            getIdentity: () => ({ sourceOperationId: 'op-1' }),
            onPayload: async () => undefined,
            waitBudgetMs: 30_000,
          }),
        HostedProductRequestError,
      );
    }
    assert.equal(fallbackCalls, 0);
  });

  it('throws HostedProductRequestError immediately without fallback on mid-stream event: error', async () => {
    let fallbackCalled = false;
    globalThis.fetch = async () =>
      new Response(
        streamFromChunks([
          'event: status\ndata: {"operationId":"op-1","status":"processing"}\n\n',
          'event: error\ndata: {"status":401,"body":{"code":"postplus_cli_auth_invalid_session","message":"Session revoked"}}\n\n',
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );

    await assert.rejects(
      () =>
        waitForMetaResearchViaSse({
          context: {
            auth: { apiBaseUrl: 'https://postplus.test', cliSessionToken: 't' },
            skillsReleaseId: 'r',
          },
          fallbackPoll: async () => {
            fallbackCalled = true;
            return null;
          },
          getIdentity: () => ({ sourceOperationId: 'op-1' }),
          onPayload: async () => undefined,
          waitBudgetMs: 30_000,
        }),
      (err) =>
        err instanceof HostedProductRequestError &&
        err.httpStatus === 401 &&
        err.productError.code === 'postplus_cli_auth_invalid_session',
    );
    assert.equal(fallbackCalled, false);
  });

  it('falls back to polling on missing stream route (404 non-run-not-found), 502/503/504, premature EOF, and ECONNRESET', async () => {
    const scenarios: Array<{ name: string; mockFetch: typeof globalThis.fetch }> = [
      {
        name: 'rolling deploy missing route 404',
        mockFetch: async () =>
          Response.json({ message: 'Not Found' }, { status: 404 }),
      },
      {
        name: '503 gateway unavailable',
        mockFetch: async () =>
          Response.json({ message: 'Bad Gateway' }, { status: 503 }),
      },
      {
        name: 'premature EOF without result or reconnect',
        mockFetch: async () =>
          new Response(
            streamFromChunks([
              'event: status\ndata: {"operationId":"op-1","status":"processing"}\n\n',
            ]),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      },
      {
        name: 'mid-stream ECONNRESET',
        mockFetch: async () =>
          new Response(
            streamFromChunks([
              'event: status\ndata: {"operationId":"op-1","status":"processing"}\n\n',
              () => {
                throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
              },
            ]),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      },
    ];

    for (const scenario of scenarios) {
      globalThis.fetch = scenario.mockFetch;
      let fallbackRemaining = -1;
      const result = await waitForMetaResearchViaSse({
        context: {
          auth: { apiBaseUrl: 'https://postplus.test', cliSessionToken: 't' },
          skillsReleaseId: 'r',
        },
        fallbackPoll: async (remaining) => {
          fallbackRemaining = remaining;
          return { recoveredByPoll: scenario.name };
        },
        getIdentity: () => ({ sourceOperationId: 'op-1' }),
        onPayload: async () => undefined,
        waitBudgetMs: 10_000,
      });

      assert.equal(
        fallbackRemaining > 0 && fallbackRemaining <= 10_000,
        true,
        scenario.name,
      );
      assert.deepEqual(result, { recoveredByPoll: scenario.name });
    }
  });
});
