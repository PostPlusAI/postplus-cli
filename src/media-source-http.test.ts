import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dns from 'node:dns/promises';
import type { LookupAddress, LookupFunction } from 'node:dns';
import { once } from 'node:events';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { Socket } from 'node:net';
import test, { type TestContext } from 'node:test';
import tls from 'node:tls';
import { promisify } from 'node:util';

import {
  createImageSourceFetcher,
  readMediaProxyEnvironment,
} from './media-source-http.js';

const target = 'p16.tiktokcdn.com';
const publicAddresses = [
  { address: '8.8.8.8', family: 4 },
  { address: '2606:4700:4700::1111', family: 6 },
];
const signal = () => AbortSignal.timeout(3000);

function environment(t: TestContext, values: Record<string, string> = {}) {
  const previous = process.env;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  process.env = values;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => {
    process.env = previous;
    Object.defineProperty(process, 'platform', platform);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

function resolveTo(t: TestContext, addresses: LookupAddress[]) {
  const lookup = t.mock.method(dns, 'lookup', async (host, options) => {
    assert.equal(host, target);
    assert.deepEqual(options, { all: true });
    return addresses;
  });
  syncBuiltinESMExports();
  return lookup;
}

// Keep the native HTTPS Agent's proxy/NO_PROXY decision. Intercept only its
// direct TLS boundary so no test can dial a public address. Invoke the supplied
// lookup exactly as a connection would and inspect the addresses it binds.
function directConnection(t: TestContext, all = true) {
  let bound: unknown[] | undefined;
  const connect = t.mock.method(tls, 'connect', (options) => {
    assert.equal(options.host, target);
    assert.equal(options.servername, target);
    assert.notEqual(options.rejectUnauthorized, false);
    assert.equal(options.socket, undefined);
    const socket = new Socket();
    // ClientRequest can queue writes while lookup is pending.
    socket.connecting = true;
    queueMicrotask(() => {
      (options.lookup as LookupFunction)(
        target,
        { all },
        (error, ...result) => {
          if (error) socket.destroy(error);
          else {
            bound = result;
            socket.destroy(
              Object.assign(new Error('test stopped before dial'), {
                code: 'ECONNREFUSED',
              }),
            );
          }
        },
      );
    });
    t.after(() => socket.destroy());
    return socket;
  });
  return {
    connect,
    get bound() {
      return bound;
    },
  };
}

async function proxy(t: TestContext, status = 200, stall = false) {
  const tunnels: string[] = [];
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const received = Promise.withResolvers<void>();
  const secure = tls.createServer({ key, cert }, (socket) => {
    socket.once('data', (data) => {
      requests.push(data.toString());
      received.resolve();
      if (stall) return;
      socket.end(
        'HTTP/1.1 302 Found\r\nLocation: https://example.com/blocked\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok',
      );
    });
  });
  secure.on('tlsClientError', () => {});
  const server = http.createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, socket) => {
    tunnels.push(req.url!);
    if (status !== 200) {
      socket.end(`HTTP/1.1 ${status} Failed\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    secure.emit('connection', socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    secure.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    tunnels,
    requests,
    received: received.promise,
  };
}

for (const [host, noProxy] of [
  [target, undefined],
  ['scontent.cdninstagram.com', 'unrelated.example'],
] as const) {
  test(`native CONNECT uses ${host} without target DNS, NO_PROXY=${noProxy}`, async (t) => {
    environment(t);
    const fixture = await proxy(t);
    process.env.HTTPS_PROXY = fixture.url;
    if (noProxy) process.env.NO_PROXY = noProxy;
    const lookup = resolveTo(t, [{ address: '198.18.0.1', family: 4 }]);
    const connect = tls.connect;
    const tlsOptions: tls.ConnectionOptions[] = [];
    t.mock.method(tls, 'connect', (options, callback) => {
      tlsOptions.push(options);
      assert.notEqual(options.rejectUnauthorized, false);
      return connect({ ...options, ca: cert }, callback);
    });
    const fetch = await createImageSourceFetcher();
    const response = await fetch(`https://${host}/photo`, signal(), {
      'X-Test': 'preserved',
      'Accept-Encoding': 'gzip',
    });
    assert.equal(await response.text(), 'ok');
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get('location'),
      'https://example.com/blocked',
    );
    assert.equal(lookup.mock.callCount(), 0);
    assert.deepEqual(fixture.tunnels, [`${host}:443`]);
    assert.equal(tlsOptions.length, 1);
    assert.equal(tlsOptions[0]!.servername, host);
    assert.ok(tlsOptions[0]!.socket);
    assert.equal(fixture.requests.length, 1);
    assert.match(fixture.requests[0]!, /X-Test: preserved/iu);
    assert.match(fixture.requests[0]!, /Accept-Encoding: identity/iu);
  });
}

for (const noProxy of [undefined, target, `${target}:443`, '*']) {
  for (const addresses of [
    [],
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '198.18.0.1', family: 4 }],
    [publicAddresses[0]!, { address: '10.0.0.1', family: 4 }],
    [publicAddresses[0]!, { address: '::1', family: 6 }],
  ]) {
    test(`direct DNS rejects all unsafe answers, NO_PROXY=${noProxy}, ${JSON.stringify(addresses)}`, async (t) => {
      environment(
        t,
        noProxy
          ? {
              HTTPS_PROXY: 'http://127.0.0.1:1',
              NO_PROXY: noProxy,
            }
          : {},
      );
      const lookup = resolveTo(t, addresses);
      const connection = directConnection(t);
      const fetch = await createImageSourceFetcher();
      await assert.rejects(fetch(`https://${target}/photo`, signal()), {
        message: 'media_source_non_public_address',
      });
      assert.equal(lookup.mock.callCount(), 1);
      assert.equal(connection.connect.mock.callCount(), 1);
      assert.equal(connection.bound, undefined);
    });
  }
  for (const all of [false, true]) {
    test(`direct DNS pins validated public answers, NO_PROXY=${noProxy}, all=${all}`, async (t) => {
      environment(
        t,
        noProxy
          ? {
              HTTPS_PROXY: 'http://127.0.0.1:1',
              NO_PROXY: noProxy,
            }
          : {},
      );
      const lookup = resolveTo(t, publicAddresses);
      const connection = directConnection(t, all);
      const fetch = await createImageSourceFetcher();
      await assert.rejects(fetch(`https://${target}/photo`, signal()), {
        message: 'media_source_network_failed',
      });
      assert.equal(lookup.mock.callCount(), 1);
      assert.deepEqual(
        connection.bound,
        all ? [publicAddresses] : ['8.8.8.8', 4],
      );
    });
  }
}

test('proxy failure never falls back to direct TLS or target DNS', async (t) => {
  environment(t);
  const fixture = await proxy(t, 502);
  process.env.HTTPS_PROXY = fixture.url;
  const lookup = resolveTo(t, publicAddresses);
  const connection = directConnection(t);
  const fetch = await createImageSourceFetcher();
  await assert.rejects(fetch(`https://${target}/photo`, signal()), {
    message: 'media_source_network_failed',
  });
  assert.deepEqual(fixture.tunnels, [`${target}:443`]);
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(connection.connect.mock.callCount(), 0);
});

test('native proxy TLS rejects an untrusted certificate and keeps its error category', async (t) => {
  environment(t);
  const fixture = await proxy(t);
  process.env.HTTPS_PROXY = fixture.url;
  const lookup = resolveTo(t, publicAddresses);
  const fetch = await createImageSourceFetcher();
  await assert.rejects(fetch(`https://${target}/photo`, signal()), {
    message: 'media_source_tls_failed',
  });
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(fixture.requests.length, 0);
});

test('DNS failure retains network category', async (t) => {
  environment(t);
  t.mock.method(dns, 'lookup', async () => {
    throw new Error('ENOTFOUND');
  });
  syncBuiltinESMExports();
  directConnection(t);
  const fetch = await createImageSourceFetcher();
  await assert.rejects(fetch(`https://${target}/photo`, signal()), {
    message: 'media_source_network_failed',
  });
});

test('cancellation during unresolved direct DNS returns promptly', async (t) => {
  environment(t);
  t.mock.method(dns, 'lookup', () => new Promise(() => {}));
  syncBuiltinESMExports();
  directConnection(t);
  const controller = new AbortController();
  const fetch = await createImageSourceFetcher();
  const pending = fetch(`https://${target}/photo`, controller.signal);
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { message: 'media_source_timeout' });
});

test('cancellation during a proxied response retains timeout category', async (t) => {
  environment(t);
  const fixture = await proxy(t, 200, true);
  process.env.HTTPS_PROXY = fixture.url;
  const lookup = resolveTo(t, publicAddresses);
  const connect = tls.connect;
  t.mock.method(tls, 'connect', (options, callback) =>
    connect({ ...options, ca: cert }, callback),
  );
  const controller = new AbortController();
  const fetch = await createImageSourceFetcher();
  const pending = fetch(`https://${target}/photo`, controller.signal);
  await fixture.received;
  controller.abort();
  await assert.rejects(pending, { message: 'media_source_timeout' });
  assert.equal(lookup.mock.callCount(), 0);
});

test('request retains its 30 second socket timeout and timeout category', async (t) => {
  environment(t);
  t.mock.method(dns, 'lookup', () => new Promise(() => {}));
  syncBuiltinESMExports();
  directConnection(t);
  t.mock.method(
    http.ClientRequest.prototype,
    'setTimeout',
    function (milliseconds, callback) {
      assert.equal(milliseconds, 30000);
      setImmediate(callback);
      return this;
    },
  );
  const fetch = await createImageSourceFetcher();
  await assert.rejects(fetch(`https://${target}/photo`, signal()), {
    message: 'media_source_timeout',
  });
});

test('invalid URL and already-cancelled calls cannot open a connection', async (t) => {
  environment(t);
  const lookup = resolveTo(t, publicAddresses);
  const connection = directConnection(t);
  const fetch = await createImageSourceFetcher();
  for (const url of [
    'http://p16.tiktokcdn.com/a',
    'https://example.com/a',
    'https://p16.tiktokcdn.com.evil.test/a',
    'https://user:pass@p16.tiktokcdn.com/a',
    'https://p16.tiktokcdn.com:444/a',
    'https://127.0.0.1/a',
  ])
    await assert.rejects(fetch(url, signal()), {
      message: 'media_source_invalid_url',
    });
  await assert.rejects(fetch(`https://${target}/a`, AbortSignal.abort()));
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(connection.connect.mock.callCount(), 0);
});

test('only explicit HTTP(S) proxy URLs are accepted with native precedence', async (t) => {
  environment(t);
  for (const value of [
    'socks5://localhost:1080',
    'socks://localhost:1080',
    'pac+https://example.com/pac',
    'file:///proxy.pac',
    'localhost:8080',
    'not a URL',
  ]) {
    process.env = { HTTPS_PROXY: value };
    await assert.rejects(readMediaProxyEnvironment(), {
      message: 'media_source_proxy_configuration_unsupported',
    });
    await assert.rejects(createImageSourceFetcher(), {
      message: 'media_source_proxy_configuration_unsupported',
    });
  }
  process.env = { ALL_PROXY: 'socks5://localhost:1080' };
  await assert.rejects(readMediaProxyEnvironment(), {
    message: 'media_source_proxy_configuration_unsupported',
  });
  for (const value of ['http://localhost:8080', 'https://localhost:8443']) {
    process.env = {
      https_proxy: value,
      HTTPS_PROXY: 'http://other:80',
      no_proxy: target,
      NO_PROXY: '*',
    };
    assert.deepEqual(await readMediaProxyEnvironment(), {
      HTTPS_PROXY: value,
      NO_PROXY: target,
    });
  }
});

test('macOS rejects automatic/SOCKS-only proxies and prefers enabled HTTPS', async (t) => {
  environment(t);
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  let stdout = '';
  const execFile = Object.assign(() => {}, {
    [promisify.custom]: async () => ({ stdout, stderr: '' }),
  });
  const previous = childProcess.execFile;
  childProcess.execFile = execFile as typeof childProcess.execFile;
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = previous;
    syncBuiltinESMExports();
  });
  for (const name of [
    'ProxyAutoConfigEnable',
    'ProxyAutoDiscoveryEnable',
    'SOCKSEnable',
  ]) {
    stdout = `<dictionary> {\n  ${name} : 1\n}`;
    await assert.rejects(readMediaProxyEnvironment(), {
      message: 'media_source_proxy_configuration_unsupported',
    });
  }
  stdout =
    '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : localhost\n  HTTPSPort : 8080\n}';
  assert.deepEqual(await readMediaProxyEnvironment(), {
    HTTPS_PROXY: 'http://localhost:8080',
  });
  stdout =
    '<dictionary> {\n  HTTPSEnable : 1\n  HTTPSProxy : localhost\n  HTTPSPort : 8080\n  SOCKSEnable : 1\n}';
  assert.deepEqual(await readMediaProxyEnvironment(), {
    HTTPS_PROXY: 'http://localhost:8080',
  });
});

// Public test-only self-signed credentials; never used outside loopback fixtures.
const key = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDgrFEWwoyHeIa7
rnZO6DFXatKW2oyuphYP4Ph9ku/j6FIk6zF0yw5vZuAVmKoI0Q68nBL+ElKI6obf
mi3vnK6I8C9JxA7QEwu4xcDhRvlD5cEE26x6qnORoemfQPb+RsEQ4kbBGcT6Cd2F
UaHF/OjE68XEFFRzUk2lG3t1NCnbyLgQQsy/vsWJnXDO8VkfsJjhG2X5lNh/D2IL
2g3j2FMxWzwjyBtce4GFkH4FWhJcVoVhnTTQxF7YbUAJxcM7bED5ssxSJdo7P4rE
CQrKsuJs+7Qw0CgtkR0jGeFPcpwQ7pVAy/qKbK+x/y6dxK5hhMelEIE/GMPrLFJW
cEHqIz8BAgMBAAECggEAE2cWPqixAa8JNbKgoXpgbnv5cVEw9pE91QO4+gFDSdOh
qnIMTJmPptPD1OGhB49kXin9Yuc6rPvSB4P1ZRzLHuTdNJnjrJkEeWHMoTfjpXc1
RuHgwJwxTFmnBxuRaQ67tCVSdnEvB2fsM0wENEi94mm5I9CcpXPtZC2eKRZG6iW/
M2WkGhMTpAnyfndO1AklzDbIoau+j6HXLoZEANKvseIyXD+6clhRfpBaKvwjUAw1
zJJoqTkkCEF8XODFXY73J0291nfekWEiVJpaw+OFvD8FOdRJdcx0kWqTB4eB+ElP
5YVvscpMt0Jdp9FKs6LG0PaHcWt+jYy8toTdv5kcVQKBgQD8aredsqusyrdzG4Uq
B9hJCSL5OLSI5lpby1WAXmW9NAw9rQvyNNeq3skOJxBPmtvA94wY7b9c/nkeylG+
h6Rzr/GTysYuXCUJecS+mKoLvLuhjqh/0msJTiEO9ExInlpHxAVFdPWmUF/rRRzS
72xK/y+uiGKiehlBG7wwk3Hu3QKBgQDj3MdacO1AKO3E9i6k7cIK9kiDtebezjth
2i75JWO5+rw6kV9ZCmK+/UTanHNtpNuxwTrtKBA5dQSwy/h9rp7S35QBXt7lKFAs
mw2ymat/WGMySoSYfLbnbnh05xhIFMRxi2qMovBKi9S1SbWBR5QvuHya8gNUvmVv
AW++lsIkdQKBgQDTpwRKBixvmheTPGs/oA5ax3987HBtLoJr4CbUmdLDgKYW/Ug8
EtUYYPDDnjvOFDLaLnhZ2tkQOA0FpW4/zes2Wjy9yVS+QOOJe4JesxI6/0lxoXZm
n+DCj7GmoXBpn+ZhsNser4DfsRuM4onV0Y7DoBCyT4gtZyZP8tqs/KWXPQKBgQCw
+afoKa9LVr6dbKt7s6IzS2e0zJIc2MasUH6NSan0J7cMMh6BFJzvQ9y3gi3wqcts
euzeh3Baf/V9r143l2mJ1NaqXdn21+G1U1RHNC1MAgVBaTklCjAw/c8W1Oo6Cc8t
dR/zTRYegA5cI3yShVql2b8FxRQrPJmhptb4izUMhQKBgQD6Mqd3lMEu15mWMa1B
iUZ9e+A9p3FDI2JhjrtrVCVVU6rwWDHjBTBqndPsDrDlqCm5+0Hq57IBVQZxLU8c
znX/SmXNPGVWq3ftnDHtM1bgUsl/IQkE1otPkkD5IeXSzNFyzlXlcvwqrzZBQSq+
uhXDvhsPZitAkvCIjhKqrz+AxA==
-----END PRIVATE KEY-----
`;
const cert = `-----BEGIN CERTIFICATE-----
MIIDVDCCAjygAwIBAgIUSnGtVaxsOy2ACGkSjXr6Cct0y9UwDQYJKoZIhvcNAQEL
BQAwHDEaMBgGA1UEAwwRcDE2LnRpa3Rva2Nkbi5jb20wHhcNMjYwOTA4MTg1NzU5
WhcNMzYwOTA1MTg1NzU5WjAcMRowGAYDVQQDDBFwMTYudGlrdG9rY2RuLmNvbTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOCsURbCjId4hruudk7oMVdq
0pbajK6mFg/g+H2S7+PoUiTrMXTLDm9m4BWYqgjRDrycEv4SUojqht+aLe+crojw
L0nEDtATC7jFwOFG+UPlwQTbrHqqc5Gh6Z9A9v5GwRDiRsEZxPoJ3YVRocX86MTr
xcQUVHNSTaUbe3U0KdvIuBBCzL++xYmdcM7xWR+wmOEbZfmU2H8PYgvaDePYUzFb
PCPIG1x7gYWQfgVaElxWhWGdNNDEXthtQAnFwztsQPmyzFIl2js/isQJCsqy4mz7
tDDQKC2RHSMZ4U9ynBDulUDL+opsr7H/Lp3ErmGEx6UQgT8Yw+ssUlZwQeojPwEC
AwEAAaOBjTCBijAdBgNVHQ4EFgQU96mX1Wc+y1tc8+HM5twzc1QweR0wHwYDVR0j
BBgwFoAU96mX1Wc+y1tc8+HM5twzc1QweR0wDwYDVR0TAQH/BAUwAwEB/zA3BgNV
HREEMDAughFwMTYudGlrdG9rY2RuLmNvbYIZc2NvbnRlbnQuY2RuaW5zdGFncmFt
LmNvbTANBgkqhkiG9w0BAQsFAAOCAQEAaRVUY4Kcts85P1kXE5MMU5f3iZLd2pG5
61F16eg6Nd78vzC9GAk9wlBkTmhfgjrnOV8Q8Nl7T0TqW4WX5x2Wv59N1tcdPpa4
bV9l/8NzWAZZRxFBDP7K4thoCarwKCttVQfARTY9IZU/egQkeqoV5eIKikQxPDZL
MFG+u7A5J1H0r1A/IwM24LxNgAhqIH/2KfXaFH4Euwupk4pYT9JykMbb/vUUexKe
qkJ+2hvxfW5kOh6pfEwhbEcTtDMVO4YqIYD5GS/GoFQQEGUDuS0jBpxXpkAqpevk
AmDUGp2YFJHgYNu2KomsQ4LCBQ97uGKOzJm2W+IiIr/cpzNCXw+lTw==
-----END CERTIFICATE-----
`;
