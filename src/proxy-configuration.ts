import { BlockList, isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EnvHttpProxyAgent } from 'undici';
import { PostPlusFailure } from './failure-contract.js';

export type ProxyConfiguration = { httpProxy: string; httpsProxy: string; noProxy: string };
function unsupported(detail: string): never {
  throw new PostPlusFailure(detail, {code:'postplus_proxy_configuration_unsupported',stage:'proxy-configuration',service:'network',retryable:false,
    action:'Configure HTTP_PROXY/HTTPS_PROXY with an HTTP(S) proxy and supported NO_PROXY exclusions.'});
}
function validateProxy(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) throw new Error();
  } catch { unsupported('PostPlus cannot use the configured proxy format.'); }
  return value;
}
function subnet(entry: string): BlockList | undefined {
  if (!entry.includes('/')) return undefined;
  let [address, prefix, extra] = entry.split('/');
  // macOS also emits network abbreviations such as 169.254/16.
  const octets = (address ?? '').split('.');
  if (octets.length < 4 && octets.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) &&
      /^\d+$/.test(prefix ?? '') && Number(prefix) <= octets.length * 8) {
    address = [...octets, ...Array(4 - octets.length).fill('0')].join('.');
  }
  const family = isIP(address ?? '');
  if (!family || extra !== undefined || !/^\d+$/.test(prefix ?? '') || Number(prefix) > (family === 4 ? 32 : 128)) {
    unsupported(`Unsupported proxy exclusion: ${entry}. Use an IP subnet such as 192.168.0.0/16.`);
  }
  const block = new BlockList();
  block.addSubnet(address!, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
  return block;
}
function validateNoProxy(value: string): string {
  for (const entry of value.split(/[,\s]+/u).filter(Boolean)) {
    if (entry === '<local>' || subnet(entry)) continue;
    if (entry.includes('<') || /^\d[\d.]*-\d/u.test(entry) || (entry.includes('*') && entry !== '*' && (!entry.startsWith('*.') || entry.slice(1).includes('*'))))
      unsupported(`Unsupported proxy exclusion: ${entry}. Use a hostname, IP subnet, <local>, or *.example.com.`);
  }
  return value;
}

// CIDR matches literal IP destinations without DNS lookups. Hostnames keep the
// proxy's DNS route; local-only exclusions must not force cloud DNS resolution.
export function proxyConfigurationForUrl(config: ProxyConfiguration, url: URL): ProxyConfiguration {
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  const family = isIP(host);
  const ordinary: string[] = [];
  for (const entry of config.noProxy.split(/[,\s]+/u).filter(Boolean)) {
    const block = subnet(entry);
    if ((entry === '<local>' && !family && !host.includes('.')) ||
        (block && family && block.check(host, family === 4 ? 'ipv4' : 'ipv6'))) {
      return { ...config, noProxy: '*' };
    }
    if (entry !== '<local>' && !block) ordinary.push(entry);
  }
  return { ...config, noProxy: ordinary.join(',') };
}
export function explicitProxyConfiguration(env: NodeJS.ProcessEnv): ProxyConfiguration | undefined {
  const http = env.http_proxy ?? env.HTTP_PROXY;
  const https = env.https_proxy ?? env.HTTPS_PROXY;
  if (http === undefined && https === undefined && (env.all_proxy || env.ALL_PROXY)) unsupported('PostPlus does not support ALL_PROXY; use an explicit HTTP(S) proxy.');
  if (http !== undefined || https !== undefined) {
    const httpProxy = validateProxy(http ?? '');
    return {httpProxy,httpsProxy:validateProxy(https || httpProxy),noProxy:validateNoProxy(env.no_proxy ?? env.NO_PROXY ?? '')};
  }
  return undefined;
}

// macOS is the only automatic system discovery backend. Other platforms use
// explicit environment proxies; absent those, their normal direct route remains.
export async function resolveProxyConfiguration(options: {
  environment?: NodeJS.ProcessEnv; platform?: string; readSystem?: () => Promise<string>;
  protocol?: string;
} = {}): Promise<ProxyConfiguration> {
  const env = options.environment ?? process.env;
  const explicit = explicitProxyConfiguration(env);
  if (explicit) return explicit;
  if ((env.no_proxy ?? env.NO_PROXY) === '*') return {httpProxy:'',httpsProxy:'',noProxy:'*'};
  let result: ProxyConfiguration = {httpProxy:'',httpsProxy:'',noProxy:validateNoProxy(env.no_proxy ?? env.NO_PROXY ?? '')};
  if ((options.platform ?? process.platform) !== 'darwin') return result;
  let raw: string;
  try {
    raw = await (options.readSystem ?? (async () => (await promisify(execFile)('/usr/sbin/scutil',['--proxy'],{timeout:3000,maxBuffer:65536})).stdout))();
  } catch (cause) {
    throw new PostPlusFailure('PostPlus could not read the system proxy settings.',{code:'postplus_system_proxy_read_failed',stage:'proxy-configuration',service:'network',retryable:false,
      action:'Check system proxy access or configure HTTP_PROXY/HTTPS_PROXY explicitly.'},{cause});
  }
  if (!/^\s*<dictionary>\s*\{[\s\S]*\}\s*$/u.test(raw)) unsupported('PostPlus could not interpret the system proxy settings.');
  const field = (name: string) => new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`,'mu').exec(raw)?.[1]?.trim();
  if (field('__SCOPED__') || field('__SUPPLEMENTAL__')) unsupported('PostPlus does not support scoped system proxy rules.');
  for (const key of ['ProxyAutoConfigEnable','ProxyAutoDiscoveryEnable','SOCKSEnable','ExcludeSimpleHostnames']) {
    const value=field(key);
    if(value !== undefined && !['0','1'].includes(value)) unsupported('PostPlus could not interpret system proxy enablement.');
  }
  if (['ProxyAutoConfigEnable','ProxyAutoDiscoveryEnable'].some((key)=>field(key)==='1')) unsupported('PostPlus does not support automatic PAC/WPAD proxy settings.');
  for (const [prefix,key] of [['HTTP','httpProxy'],['HTTPS','httpsProxy']] as const) {
    const enabled = field(`${prefix}Enable`);
    if (enabled !== undefined && !['0','1'].includes(enabled)) unsupported('PostPlus could not interpret system proxy enablement.');
    if (enabled !== '1') continue;
    const host=field(`${prefix}Proxy`); const port=field(`${prefix}Port`);
    if (!host || !/^[a-zA-Z0-9.\-]+$/u.test(host) || !port || !/^\d+$/u.test(port) || +port<1 || +port>65535) unsupported('PostPlus could not interpret the system proxy endpoint.');
    result[key]=`http://${host}:${port}`;
  }
  const requestedProxy = (options.protocol ?? 'https:') === 'http:' ? result.httpProxy : result.httpsProxy;
  if (field('SOCKSEnable') === '1' && !requestedProxy) {
    unsupported('PostPlus cannot use the system SOCKS proxy for this request; configure its HTTP/HTTPS proxy.');
  }
  // System HTTPS disabled means HTTPS is direct, unlike HTTP_PROXY's documented
  // environment fallback. Passing empty httpsProxy preserves that distinction.
  if (!result.httpProxy && !result.httpsProxy) return result;
  const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/u.exec(raw)?.[1];
  if (field('ExceptionsList') && exceptions === undefined) unsupported('PostPlus could not interpret system proxy exclusions.');
  if (env.no_proxy === undefined && env.NO_PROXY === undefined && exceptions !== undefined) {
    result.noProxy=validateNoProxy(exceptions.split('\n').map((line)=>line.trim()).filter(Boolean).map((line)=>{
      const match=/^\d+\s*:\s*(.+)$/u.exec(line);
      if (!match) unsupported('PostPlus could not interpret system proxy exclusions.');
      return match[1]!;
    }).join(','));
  }
  if (env.no_proxy === undefined && env.NO_PROXY === undefined && field('ExcludeSimpleHostnames') === '1') {
    result.noProxy = [result.noProxy, '<local>'].filter(Boolean).join(',');
  }
  return result;
}

export async function createProxyDispatcher(options: ConstructorParameters<typeof EnvHttpProxyAgent>[0] = {}, url: URL) {
  const protocol = url.protocol;
  const config = proxyConfigurationForUrl(await resolveProxyConfiguration({ protocol }), url);
  return new EnvHttpProxyAgent({...options,...config,...(protocol === 'https:' && !config.httpsProxy ? {httpProxy:''} : {})});
}
