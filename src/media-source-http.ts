import { isTlsFailure, TLS_FAILURE_ACTION } from './network-diagnostics.js';
import { resolveProxyConfiguration } from './proxy-configuration.js';
import { EnvHttpProxyAgent, request } from 'undici';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

// Only the public platforms and original-image CDNs used by this operation.
// No arbitrary URL fetcher, account cookies, redirects, or environment writes.
const hosts =
  /(?:^|\.)(?:instagram\.com|cdninstagram\.com|fbcdn\.net|tiktok\.com|tiktokcdn(?:-us|-eu)?\.com|tiktokcdn\.eu|byteoversea\.com)$/u;
const reserved = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  reserved.addSubnet(address, prefix, 'ipv4');

export function assertImageSourceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('media_source_invalid_url');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.test(url.hostname)
  )
    throw new Error('media_source_invalid_url');
  return url;
}

export function isPublicImageSourceAddress(address: string) {
  if (isIP(address) === 4) return !reserved.check(address, 'ipv4');
  // Use public global-unicast IPv6 only; exclude transition/documentation space.
  return (
    isIP(address) === 6 &&
    /^[23]/u.test(address) &&
    !/^2001:(?:0*:|db8:)/iu.test(address) &&
    !/^2002:/iu.test(address)
  );
}

export async function readMediaProxyEnvironment(): Promise<Record<string,string>> {
  const config=await resolveProxyConfiguration();
  return {...(config.httpProxy ? {HTTP_PROXY:config.httpProxy}:{}),...(config.httpsProxy ? {HTTPS_PROXY:config.httpsProxy}:{}),...(config.noProxy ? {NO_PROXY:config.noProxy}:{})};
}

export async function createImageSourceFetcher() {
  const config=await resolveProxyConfiguration();
  return async (value:string, signal:AbortSignal, headers:Record<string,string>={}):Promise<Response> => {
    const url=assertImageSourceUrl(value);
    signal.throwIfAborted();
    const dispatcher=new EnvHttpProxyAgent({...config,...(!config.httpsProxy ? {httpProxy:''}:{}),connect:{
      lookup: (host, options, callback) => {
        let settled=false;
        const finish=(error:Error | null, addresses:LookupAddress[] = []) => {
          if (settled) return; settled=true; signal.removeEventListener('abort',abort);
          if (error) { callback(error,'',4); return; }
          const first=addresses[0]!;
          if (typeof options === 'object' && options?.all) callback(null,addresses);
          else callback(null,first.address,first.family);
        };
        const abort=()=>finish(new Error('media_source_timeout'));
        signal.addEventListener('abort',abort,{once:true});
        if (signal.aborted) { abort(); return; }
        lookup(host,{all:true}).then((addresses) => {
          if (!addresses.length || addresses.some(({address}) => !isPublicImageSourceAddress(address))) finish(new Error('media_source_non_public_address'));
          else finish(null,addresses);
        }, (cause) => finish(new Error('media_source_network_failed',{cause})));
      },
    }});
    try {
      const incoming=await request(url,{dispatcher,signal,method:'GET',headers:{...headers,'Accept-Encoding':'identity'},headersTimeout:30000,bodyTimeout:30000});
      const responseHeaders=new Headers();
      for (const [key,value] of Object.entries(incoming.headers))
        for (const item of Array.isArray(value)?value:[value]) if(item!==undefined) responseHeaders.append(key,item);
      return new Response([204,304].includes(incoming.statusCode)?null:Readable.toWeb(incoming.body) as ReadableStream<Uint8Array>,{status:incoming.statusCode,headers:responseHeaders});
    } catch(error) {
      throw Object.assign(new Error(signal.aborted || ['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes((error as {code?:string}).code ?? '') || error instanceof Error && error.message==='media_source_timeout' ? 'media_source_timeout' : error instanceof Error && error.message==='media_source_non_public_address' ? 'media_source_non_public_address' : isTlsFailure(error) ? 'media_source_tls_failed' : 'media_source_network_failed',{cause:error}),
        isTlsFailure(error)?{code:'media_source_tls_failed',stage:'request',service:'external-http',retryable:false,action:TLS_FAILURE_ACTION}:{});
    } finally { void dispatcher.close().catch(() => dispatcher.destroy()); }
  };
}
