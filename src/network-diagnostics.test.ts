import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
const actualPlatform=Object.getOwnPropertyDescriptor(process,'platform')!;
beforeEach(()=>Object.defineProperty(process,'platform',{...actualPlatform,value:'linux'}));
afterEach(()=>Object.defineProperty(process,'platform',actualPlatform));
import { assertEnvironmentProxyReady, fetchWithNetworkDiagnostics, isNetworkFailure, PostPlusNetworkRequestError } from './network-diagnostics.js';
import { toFailureFact } from './failure-contract.js';

const target = new URL('https://api.postplus.test/resource');
for (const scheme of ['http', 'https', 'socks5']) {
  for (const key of ['ALL_PROXY', 'all_proxy']) {
    test(`${key} ${scheme} alone fails even with environment proxy enabled`, (t) => {
      const env = process.env;
      t.after(() => { process.env = env; });
      process.env = { [key]: `${scheme}://user:secret@localhost:1234`, NODE_USE_ENV_PROXY: '1' };
      assert.throws(() => assertEnvironmentProxyReady(target), (error) => {
        const fact = toFailureFact(error);
        assert.equal(fact.retryable, false);
        assert.match(fact.action, /HTTPS_PROXY/);
        assert.doesNotMatch(JSON.stringify(fact), /secret/);
        return true;
      });
    });
  }
}

test('native proxy selection and NO_PROXY matching use lowercase precedence', (t) => {
  const env = process.env;
  t.after(() => { process.env = env; });
  process.env = { https_proxy: 'http://localhost:8080', HTTPS_PROXY: 'socks5://localhost:8081', NODE_USE_ENV_PROXY: '1', ALL_PROXY: 'socks5://localhost:8082' };
  assert.doesNotThrow(() => assertEnvironmentProxyReady(target));
  process.env = { HTTPS_PROXY: 'http://localhost:8080' };
  for (const no_proxy of ['api.postplus.test', 'api.postplus.test:443', '.postplus.test', '*.postplus.test', '*', 'other.test api.postplus.test']) {
    process.env.no_proxy = no_proxy;
    assert.doesNotThrow(() => assertEnvironmentProxyReady(target));
  }
  for (const no_proxy of ['', 'postplus.test', 'api.postplus.test:80']) {
    process.env.no_proxy = no_proxy;
    process.env.NO_PROXY = '*';
    assert.doesNotThrow(() => assertEnvironmentProxyReady(target));
  }
});

for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
  test(`TLS ${code} retains actionable nonretryable cause`, async (t) => {
    const env = process.env;
    t.after(() => { process.env = env; });
    process.env = {};
    const cause = Object.assign(new Error('certificate rejected'), { code });
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed', { cause }); });
    await assert.rejects(fetchWithNetworkDiagnostics(target, {}, { label: 'test', redirectPolicy: 'error' }), (error) => {
      assert.ok(error instanceof PostPlusNetworkRequestError);
      const fact = toFailureFact(error);
      assert.equal(fact.retryable, false);
      assert.match(fact.action, /NODE_EXTRA_CA_CERTS/);
      assert.equal(fact.cause.at(-1)?.code, code);
      assert.equal(isNetworkFailure(cause), true);
      return true;
    });
  });
}
