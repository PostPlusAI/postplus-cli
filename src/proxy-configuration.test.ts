import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveProxyConfiguration} from './proxy-configuration.js';
const system=(body:string)=>`<dictionary> {\n${body}\n}`;
const read=(body:string)=>()=>Promise.resolve(system(body));

test('explicit proxy env is authoritative without system discovery',async()=>{
  for(const environment of [{HTTPS_PROXY:'http://localhost:8080',NO_PROXY:'.example.com'},{NO_PROXY:'*'},{https_proxy:'',HTTPS_PROXY:'socks5://bad'}]) {
    const result=await resolveProxyConfiguration({environment,platform:'darwin',readSystem:async()=>{throw new Error('must not read system');}});
    assert.equal(result.noProxy,environment.NO_PROXY ?? '');
  }
});
test('macOS reads independent HTTP/HTTPS settings and exceptions',async()=>{
  assert.deepEqual(await resolveProxyConfiguration({environment:{},platform:'darwin',readSystem:read('HTTPEnable : 1\nHTTPProxy : localhost\nHTTPPort : 8080\nHTTPSEnable : 1\nHTTPSProxy : secure.local\nHTTPSPort : 8443\nExceptionsList : <array> {\n0 : *.example.com\n1 : localhost\n}')}),{httpProxy:'http://localhost:8080',httpsProxy:'http://secure.local:8443',noProxy:'*.example.com,localhost'});
  assert.deepEqual(await resolveProxyConfiguration({environment:{},platform:'darwin',readSystem:read('HTTPEnable : 1\nHTTPProxy : localhost\nHTTPPort : 8080\nHTTPSEnable : 0')}),{httpProxy:'http://localhost:8080',httpsProxy:'',noProxy:''});
});
for(const body of ['ProxyAutoConfigEnable : 1','ProxyAutoDiscoveryEnable : 1','SOCKSEnable : 1','__SCOPED__ : <dictionary> {}','HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 99999','HTTPSEnable : garbage','HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 8080\nExcludeSimpleHostnames : 1','HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 8080\nExceptionsList : <array> {\n0 : 10.0.0.0/8\n}']) {
  test(`unsupported macOS configuration fails closed: ${body.split('\n')[0]}`,async()=>{
    await assert.rejects(resolveProxyConfiguration({environment:{},platform:'darwin',readSystem:read(body)}),{code:'postplus_proxy_configuration_unsupported'});
  });
}
test('system read errors and malformed results never imply direct access',async()=>{
  await assert.rejects(resolveProxyConfiguration({environment:{},platform:'darwin',readSystem:async()=>{throw new Error('denied');}}),{code:'postplus_system_proxy_read_failed'});
  await assert.rejects(resolveProxyConfiguration({environment:{},platform:'darwin',readSystem:async()=>''}),{code:'postplus_proxy_configuration_unsupported'});
});
test('non-mac platforms preserve normal direct mode and reject unsupported explicit proxies',async()=>{
  for(const platform of ['linux','win32']) {
    assert.deepEqual(await resolveProxyConfiguration({environment:{},platform}),{httpProxy:'',httpsProxy:'',noProxy:''});
    await assert.rejects(resolveProxyConfiguration({environment:{ALL_PROXY:'socks5://localhost:1080'},platform}),{code:'postplus_proxy_configuration_unsupported'});
  }
});

test('NO_PROXY-only overrides system exclusions without disabling the system route',async()=>{
  assert.deepEqual(await resolveProxyConfiguration({environment:{NO_PROXY:'localhost'},platform:'darwin',readSystem:read('HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 8080\nExceptionsList : <array> {\n0 : other.example\n}')}),{httpProxy:'',httpsProxy:'http://localhost:8080',noProxy:'localhost'});
});

test('coexisting SOCKS does not reject an explicit system route for the requested protocol', async () => {
  for (const protocol of ['http:', 'https:']) {
    const prefix = protocol === 'http:' ? 'HTTP' : 'HTTPS';
    const options = { environment: {}, platform: 'darwin', protocol,
      readSystem: read(`SOCKSEnable : 1\n${prefix}Enable : 1\n${prefix}Proxy : localhost\n${prefix}Port : 8080`) };
    const config = await resolveProxyConfiguration(options);
    assert.equal(protocol === 'http:' ? config.httpProxy : config.httpsProxy, 'http://localhost:8080');
    await assert.rejects(resolveProxyConfiguration({ ...options, protocol: protocol === 'http:' ? 'https:' : 'http:' }),
      { code: 'postplus_proxy_configuration_unsupported' });
  }
});

test('coexisting SOCKS does not bypass unsupported system exclusions', async () => {
  await assert.rejects(resolveProxyConfiguration({ environment: {}, platform: 'darwin',
    readSystem: read('SOCKSEnable : 1\nHTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 8080\nExceptionsList : <array> {\n0 : 10.0.0.0/8\n}') }),
    /proxy exclusion/);
});
