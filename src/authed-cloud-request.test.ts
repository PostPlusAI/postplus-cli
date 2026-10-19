import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sendAuthedCloudRequest } from './authed-cloud-request.js';
import { PostPlusClientUpgradeRequiredError } from './client-compatibility.js';

// All command families share this boundary, including new commands whose
// business error handlers have no knowledge of the automatic updater.
test('shared request preserves upgrade identity after auth refresh for GET and POST', async (t) => {
  const config = await mkdtemp(join(tmpdir(), 'postplus-request-upgrade-'));
  const previousConfig = process.env.POSTPLUS_CONFIG_DIR;
  process.env.POSTPLUS_CONFIG_DIR = config;
  t.after(async () => {
    if (previousConfig === undefined) delete process.env.POSTPLUS_CONFIG_DIR;
    else process.env.POSTPLUS_CONFIG_DIR = previousConfig;
    await rm(config, { recursive: true, force: true });
  });
  for (const method of ['GET', 'POST'] as const) {
    let requests = 0;
    let refreshes = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      return requests === 1 ? Response.json({}, { status: 401 })
        : Response.json({ code: 'postplus_client_upgrade_required' }, { status: 426 });
    });
    await assert.rejects(sendAuthedCloudRequest({
      auth: { apiBaseUrl: 'https://postplus.test', cliSessionToken: 'old' },
      pathName: '/new-command', method,
      retryOn401: async () => { refreshes++; return { apiBaseUrl: 'https://postplus.test', cliSessionToken: 'fresh' }; },
    }), PostPlusClientUpgradeRequiredError);
    assert.equal(requests, 2, 'transport classifies but never replays a task');
    assert.equal(refreshes, 1);
    t.mock.restoreAll();
  }
});

test('HTTP status or upgrade prose alone never triggers recovery or consumes the response', async (t) => {
  for (const [status, body] of [
    [426, '<html>upgrade required</html>'],
    [426, JSON.stringify({ code: 'postplus_cloud_release_in_progress' })],
    [403, JSON.stringify({ error: 'upgrade required' })],
    [503, JSON.stringify({ error: 'unavailable' })],
    [200, JSON.stringify({ code: 'postplus_client_upgrade_required' })],
  ] as const) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { status }));
    const response = await sendAuthedCloudRequest({
      auth: { apiBaseUrl: 'https://postplus.test', cliSessionToken: 'fixture' },
      pathName: '/fixture', skillsReleaseId: 'fixture',
    });
    assert.equal(response.status, status);
    assert.equal(await response.text(), body);
    t.mock.restoreAll();
  }
});
