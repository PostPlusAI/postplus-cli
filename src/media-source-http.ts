import { execFile } from 'node:child_process';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { Agent, request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

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

export async function readMediaProxyEnvironment(): Promise<
  Record<string, string>
> {
  const proxy =
    process.env.https_proxy ??
    process.env.HTTPS_PROXY ??
    process.env.http_proxy ??
    process.env.HTTP_PROXY;
  const noProxy = process.env.no_proxy ?? process.env.NO_PROXY;
  if (proxy)
    return { HTTPS_PROXY: proxy, ...(noProxy ? { NO_PROXY: noProxy } : {}) };
  if (process.env.ALL_PROXY || process.env.all_proxy)
    throw new Error('media_source_proxy_configuration_unsupported');
  if (process.platform !== 'darwin') return {};
  const { stdout } = await promisify(execFile)(
    '/usr/sbin/scutil',
    ['--proxy'],
    {
      timeout: 3000,
      maxBuffer: 64 * 1024,
    },
  );
  const field = (name: string) =>
    new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'mu').exec(stdout)?.[1]?.trim();
  if (field('ProxyAutoConfigEnable') === '1')
    throw new Error('media_source_proxy_configuration_unsupported');
  if (field('HTTPSEnable') !== '1') return {};
  const host = field('HTTPSProxy');
  const port = field('HTTPSPort');
  if (
    !host ||
    !/^[a-zA-Z0-9.\-]+$/u.test(host) ||
    !port ||
    !/^\d+$/u.test(port)
  )
    throw new Error('media_source_proxy_configuration_unsupported');
  return { HTTPS_PROXY: `http://${host}:${port}` };
}

export async function createImageSourceFetcher() {
  const proxyEnv = await readMediaProxyEnvironment();
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (
    Object.keys(proxyEnv).length &&
    (major < 24 || (major === 24 && minor < 5))
  )
    throw new Error('media_source_proxy_runtime_unsupported');
  const agent = new Agent({ keepAlive: false, proxyEnv });
  return async (
    value: string,
    signal: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<Response> => {
    const url = assertImageSourceUrl(value);
    signal.throwIfAborted();
    // Validate DNS even for a trusted user-configured proxy. In direct mode,
    // bind the exact validated address. A configured proxy owns its DNS path.
    const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
      const aborted = () => reject(new Error('media_source_timeout'));
      signal.addEventListener('abort', aborted, { once: true });
      lookup(url.hostname, { all: true })
        .then(resolve, () => reject(new Error('media_source_network_failed')))
        .finally(() => signal.removeEventListener('abort', aborted));
      if (signal.aborted) aborted();
    });
    signal.throwIfAborted();
    if (
      !addresses.length ||
      addresses.some(({ address }) => !isPublicImageSourceAddress(address))
    )
      throw new Error('media_source_non_public_address');
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        {
          agent,
          signal,
          method: 'GET',
          headers: { ...headers, 'Accept-Encoding': 'identity' },
          lookup: (_host, _options, callback) => {
            const first = addresses[0]!;
            if (typeof _options === 'object' && _options?.all)
              callback(null, addresses);
            else callback(null, first.address, first.family);
          },
        },
        (incoming) => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers))
            for (const item of Array.isArray(value) ? value : [value])
              if (item !== undefined) responseHeaders.append(key, item);
          const status = incoming.statusCode ?? 502;
          resolve(
            new Response(
              [204, 304].includes(status)
                ? null
                : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
              { status, headers: responseHeaders },
            ),
          );
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            signal.aborted
              ? 'media_source_timeout'
              : /^(?:ERR_TLS|CERT_|ERR_SSL|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY)/u.test(
                    error.code ?? '',
                  )
                ? 'media_source_tls_failed'
                : 'media_source_network_failed',
          ),
        ),
      );
      req.setTimeout(30000, () =>
        req.destroy(new Error('media_source_timeout')),
      );
      req.end();
    });
  };
}
