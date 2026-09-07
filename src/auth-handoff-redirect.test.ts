import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import { resolve } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';

import {
  acknowledgeCloudAuthLogin,
  pollCloudAuthLogin,
} from './auth-login.js';

describe('auth handoff redirect boundary', () => {
  const previousConfigDir = process.env.POSTPLUS_CONFIG_DIR;
  const previousHome = process.env.HOME;
  const previousDirectory = process.cwd();
  let configDir: string;

  before(async () => {
    const fixtureRoot = resolve(import.meta.dirname, '../.local');
    await mkdir(fixtureRoot, { recursive: true });
    configDir = await mkdtemp(resolve(fixtureRoot, 'auth-handoff-redirect-'));
    process.env.POSTPLUS_CONFIG_DIR = configDir;
    process.env.HOME = configDir;
    process.chdir(configDir);
  });

  after(async () => {
    if (previousConfigDir === undefined) delete process.env.POSTPLUS_CONFIG_DIR;
    else process.env.POSTPLUS_CONFIG_DIR = previousConfigDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    process.chdir(previousDirectory);
    await rm(configDir, { recursive: true, force: true });
  });

  async function listen(t: TestContext, handler: RequestListener) {
    const server = createServer(handler);
    t.after(() => close(server));
    await new Promise<void>((resolveListen) =>
      server.listen(0, '127.0.0.1', resolveListen),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  }

  async function close(server: Server) {
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
      server.closeAllConnections();
    });
  }

  for (const action of ['poll', 'acknowledge'] as const) {
    const body = {
      requestId: 'test-request',
      pollSecret: 'test-poll-secret',
      ...(action === 'acknowledge'
        ? { cliSessionToken: 'test-session-token' }
        : {}),
    };
    const success = action === 'poll' ? { status: 'pending' } : { ok: true };
    const invoke = (apiBaseUrl: string) =>
      action === 'poll'
        ? pollCloudAuthLogin({ apiBaseUrl, ...body })
        : acknowledgeCloudAuthLogin({
            apiBaseUrl,
            ...body,
            cliSessionToken: 'test-session-token',
          });

    for (const status of [301, 302, 303, 307, 308]) {
      for (const contentType of ['text/html', 'application/json']) {
        it(`${action} rejects ${status} ${contentType} without forwarding or retrying`, async (t) => {
          const forwarded: string[] = [];
          const target = await listen(t, async (request, response) => {
            let received = '';
            for await (const chunk of request) received += chunk;
            forwarded.push(received);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(success));
          });
          const requests: { path: string | undefined; body: unknown }[] = [];
          const origin = await listen(t, async (request, response) => {
            let received = '';
            for await (const chunk of request) received += chunk;
            requests.push({ path: request.url, body: JSON.parse(received) });
            response.writeHead(status, {
              location: `${target}/capture?secret=do-not-display`,
              'content-type': contentType,
            });
            response.end(
              contentType === 'application/json'
                ? JSON.stringify(success)
                : '<html>Redirecting</html>',
            );
          });

          let failure: unknown;
          try {
            await invoke(origin);
          } catch (error) {
            failure = error;
          }
          assert.deepEqual(
            forwarded,
            [],
            'no request or body reaches the redirect target',
          );
          assert.deepEqual(
            requests,
            [{ path: `/api/postplus-cli/auth/login/${action}`, body }],
            'the original handoff request is never retried',
          );
          assert.ok(failure instanceof Error);
          assert.match(failure.message, /redirect/i);
          assert.match(failure.message, new RegExp(String(status)));
          assert.doesNotMatch(
            failure.message,
            /test-poll-secret|test-session-token|do-not-display/,
          );
          if (action === 'acknowledge')
            assert.match(failure.message, /postplus auth validate/);
        });
      }
    }

    for (const loss of ['connection', 'body', 'persistent'] as const) {
      it(`${action} allows at most one retry after ${loss} response loss`, async (t) => {
        const requests: unknown[] = [];
        const origin = await listen(t, async (request, response) => {
          let received = '';
          for await (const chunk of request) received += chunk;
          requests.push(JSON.parse(received));
          if (requests.length === 1 || loss === 'persistent') {
            if (loss === 'body') {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.write('{');
              setImmediate(() => response.destroy());
            } else response.destroy();
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(success));
        });

        if (loss === 'persistent') await assert.rejects(invoke(origin));
        else
          assert.deepEqual(
            await invoke(origin),
            action === 'poll' ? success : undefined,
          );
        assert.deepEqual(requests, [body, body]);
      });
    }
  }
});
