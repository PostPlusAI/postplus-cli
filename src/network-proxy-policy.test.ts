import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { resolveEnvironmentProxyPolicy } from './network-proxy-policy.js';

const execFileAsync = promisify(execFile);
const PROXY_ENV_NAMES = [
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;

describe('CLI environment proxy policy', () => {
  it('uses standard proxy precedence and always preserves loopback bypasses', () => {
    const policy = resolveEnvironmentProxyPolicy({
      ALL_PROXY: 'http://all.example:9000',
      HTTPS_PROXY: 'http://uppercase.example:9001',
      NO_PROXY: '.internal.example',
      https_proxy: 'http://lowercase.example:9002',
    });

    assert.equal(policy.httpProxy, 'http://all.example:9000');
    assert.equal(policy.httpsProxy, 'http://lowercase.example:9002');
    assert.deepEqual(
      new Set(policy.noProxy.split(',')),
      new Set(['.internal.example', 'localhost', '127.0.0.1', '::1', '[::1]']),
    );
  });

  it('keeps direct networking when no proxy is configured', () => {
    const policy = resolveEnvironmentProxyPolicy({});

    assert.equal(policy.httpProxy, null);
    assert.equal(policy.httpsProxy, null);
    assert.equal(policy.noProxy, 'localhost,127.0.0.1,::1,[::1]');
  });

  it('proxies external fetches while bypassing loopback without NODE_USE_ENV_PROXY', async () => {
    const proxyRequests: string[] = [];
    const directRequests: string[] = [];
    const proxyServer = createTunnelProxy(proxyRequests);
    const directServer = http.createServer((request, response) => {
      directRequests.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ route: 'direct' }));
    });

    proxyServer.listen(0, '127.0.0.1');
    directServer.listen(0, '127.0.0.1');
    await Promise.all([
      once(proxyServer, 'listening'),
      once(directServer, 'listening'),
    ]);

    const proxyAddress = proxyServer.address();
    const directAddress = directServer.address();
    assert(proxyAddress && typeof proxyAddress === 'object');
    assert(directAddress && typeof directAddress === 'object');

    const childScript = [
      `const { ensureEnvironmentProxyDispatcher } = await import(${JSON.stringify(resolve(process.cwd(), 'src/network-proxy-policy.ts'))});`,
      'ensureEnvironmentProxyDispatcher();',
      "const external = await fetch('http://provider.invalid/external');",
      `const local = await fetch('http://127.0.0.1:${directAddress.port}/local');`,
      'process.stdout.write(JSON.stringify({ external: await external.json(), local: await local.json() }));',
      'process.exit(0);',
    ].join('\n');
    const env = { ...process.env };
    for (const name of PROXY_ENV_NAMES) {
      delete env[name];
    }
    env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', childScript],
        { env },
      );
      assert.deepEqual(JSON.parse(stdout), {
        external: { route: 'proxy' },
        local: { route: 'direct' },
      });
      assert.deepEqual(proxyRequests, [
        'CONNECT provider.invalid:80',
        'GET /external HTTP/1.1',
      ]);
      assert.deepEqual(directRequests, ['/local']);
    } finally {
      await Promise.all([closeServer(proxyServer), closeServer(directServer)]);
    }
  });
});

async function closeServer(server: http.Server) {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
}

function createTunnelProxy(requests: string[]) {
  const server = http.createServer();
  server.on('connect', (request, socket) => {
    requests.push(`CONNECT ${request.url ?? ''}`);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', (data) => {
      requests.push(data.toString('utf8').split('\r\n', 1)[0] ?? '');
      const body = JSON.stringify({ route: 'proxy' });
      socket.end(
        [
          'HTTP/1.1 200 OK',
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          body,
        ].join('\r\n'),
      );
    });
  });
  return server;
}
