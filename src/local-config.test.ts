import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { loginWithCloudHandoff } from './auth-login.js';
import {
  PostPlusLocalConfigError,
  assertConfigFilePermissions,
  assertLocalConfigWritable,
  readLocalConfig,
  usesPosixConfigPermissions,
  writeLocalConfig,
} from './local-state.js';

describe('local configuration persistence', { concurrency: false }, () => {
  let root: string;
  let previous: string | undefined;
  const originalOpen = fs.promises.open;
  const originalRead = fs.promises.readFile;
  beforeEach(async () => {
    previous = process.env.POSTPLUS_CONFIG_DIR;
    root = await fs.promises.mkdtemp(
      join(os.tmpdir(), 'postplus-config-test-'),
    );
    process.env.POSTPLUS_CONFIG_DIR = root;
    await writeLocalConfig({ cliSessionToken: 'synthetic-old' });
  });
  afterEach(async () => {
    mock.restoreAll();
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.POSTPLUS_CONFIG_DIR;
    else process.env.POSTPLUS_CONFIG_DIR = previous;
    // Only this test's freshly minted directory, never the acceptance environment.
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  const denied = () =>
    Object.assign(new Error('sensitive-config-content'), { code: 'EPERM' });
  const failsAt = (stage: string) => (error: unknown) => {
    assert.ok(error instanceof PostPlusLocalConfigError);
    assert.equal(error.stage, stage);
    assert.equal(error.systemCode, 'EPERM');
    assert.ok(!error.message.includes('sensitive-config-content'));
    return true;
  };
  async function unchanged() {
    assert.equal((await readLocalConfig())?.cliSessionToken, 'synthetic-old');
    assert.deepEqual(await fs.promises.readdir(root), ['config.json']);
  }

  it('commits the whole config with private POSIX permissions and no temporary residue', async () => {
    await writeLocalConfig({
      cliSessionToken: 'synthetic-new',
      cliVersion: '0.2.8',
    });
    assert.equal((await readLocalConfig())?.cliSessionToken, 'synthetic-new');
    if (process.platform !== 'win32')
      assert.equal(
        (await fs.promises.stat(join(root, 'config.json'))).mode & 0o777,
        0o600,
      );
    assert.deepEqual(await fs.promises.readdir(root), ['config.json']);
  });
  it('probes persistence without overwriting the current account', async () => {
    const before = await originalRead(join(root, 'config.json'), 'utf8');
    await assertLocalConfigWritable();
    assert.equal(await originalRead(join(root, 'config.json'), 'utf8'), before);
    await unchanged();
  });
  for (const method of ['writeFile', 'chmod'] as const) {
    it(
      `preserves the old config when staged ${method} fails`,
      { skip: method === 'chmod' && process.platform === 'win32' },
      async () => {
        mock.method(
          fs.promises,
          'open',
          async (...args: Parameters<typeof originalOpen>) => {
            const file = await originalOpen(...args);
            mock.method(file, method, async () => {
              throw denied();
            });
            return file;
          },
        );
        syncBuiltinESMExports();
        await assert.rejects(
          writeLocalConfig({ cliSessionToken: 'synthetic-new' }),
          failsAt(method === 'chmod' ? 'permissions' : 'write'),
        );
        await unchanged();
      },
    );
  }
  it('preserves the old config on atomic replacement failure, without deleting the target', async () => {
    mock.method(fs.promises, 'rename', async () => {
      throw denied();
    });
    syncBuiltinESMExports();
    await assert.rejects(
      writeLocalConfig({ cliSessionToken: 'synthetic-new' }),
      failsAt('commit'),
    );
    await unchanged();
  });
  it('reports a read denial separately and does not reveal file contents', async () => {
    mock.method(fs.promises, 'readFile', async () => {
      throw denied();
    });
    syncBuiltinESMExports();
    await assert.rejects(readLocalConfig(), failsAt('read'));
  });
  it('does not expose malformed config JSON in the error', async () => {
    await fs.promises.writeFile(
      join(root, 'config.json'),
      '{"cliSessionToken":"synthetic-secret" BROKEN',
    );
    await assert.rejects(readLocalConfig(), (error: unknown) => {
      assert.ok(error instanceof PostPlusLocalConfigError);
      assert.equal(error.systemCode, 'INVALID_JSON');
      assert.ok(!error.message.includes('synthetic-secret'));
      return true;
    });
  });
  it('does not treat Windows POSIX mode bits as ACLs, but retains write denial', async () => {
    assert.equal(usesPosixConfigPermissions('win32'), false);
    assert.equal(usesPosixConfigPermissions('linux'), true);
    mock.method(os, 'platform', () => 'win32');
    const permissions = mock.method(fs.promises, 'chmod', async () => {
      throw denied();
    });
    mock.method(
      fs.promises,
      'open',
      async (...args: Parameters<typeof originalOpen>) => {
        const file = await originalOpen(...args);
        mock.method(file, 'chmod', async () => {
          throw denied();
        });
        return file;
      },
    );
    syncBuiltinESMExports();
    await assertConfigFilePermissions();
    await writeLocalConfig({ cliSessionToken: 'synthetic-new' });
    assert.equal(permissions.mock.callCount(), 0);
    mock.method(fs.promises, 'access', async () => {
      throw denied();
    });
    syncBuiltinESMExports();
    await assert.rejects(
      writeLocalConfig({ cliSessionToken: 'synthetic-denied' }),
      failsAt('write'),
    );
    assert.equal((await readLocalConfig())?.cliSessionToken, 'synthetic-new');
  });
  it('rejects unusable storage before starting browser authorization', async () => {
    let requests = 0;
    mock.method(globalThis, 'fetch', async () => {
      requests++;
      throw new Error('Unexpected network');
    });
    mock.method(fs.promises, 'open', async () => {
      throw denied();
    });
    syncBuiltinESMExports();
    await assert.rejects(
      loginWithCloudHandoff({ browser: false }),
      failsAt('write'),
    );
    assert.equal(requests, 0);
    await unchanged();
  });
  it('still reports a final save failure after approval without restarting login', async () => {
    const requests: string[] = [];
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const route = new URL(String(url)).pathname;
      requests.push(route);
      const account = {
        accountId: 'test-account',
        accountName: 'Test account',
        accountSlug: null,
        userId: 'test-user',
        userEmail: 'test@example.test',
        accountType: 'personal',
        subscriptionStatus: null,
      };
      if (route.endsWith('/start'))
        return Response.json({
          requestId: 'test-request',
          pollSecret: 'synthetic-poll',
          userCode: '123456',
          verificationUrl: 'https://postplus.io/auth/cli-login?test=1',
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          pollIntervalSeconds: 1,
        });
      if (route.endsWith('/poll'))
        return Response.json({
          ...account,
          status: 'completed',
          cliSessionToken: 'synthetic-new',
          sessionExpiresAt: 1900000000,
        });
      if (route.endsWith('/whoami')) return Response.json(account);
      throw new Error(`Unexpected route ${route}`);
    });
    mock.method(fs.promises, 'rename', async () => {
      throw denied();
    });
    syncBuiltinESMExports();
    await assert.rejects(
      loginWithCloudHandoff({ browser: false }),
      failsAt('commit'),
    );
    assert.equal(
      requests.filter((route) => route.endsWith('/start')).length,
      1,
    );
    assert.equal(requests.filter((route) => route.endsWith('/poll')).length, 1);
    assert.equal(
      requests.filter((route) => route.endsWith('/acknowledge')).length,
      0,
      'failed durable save must never activate the credential',
    );
    assert.equal(
      requests.filter((route) => route.endsWith('/whoami')).length,
      0,
    );
    await unchanged();
  });
});
