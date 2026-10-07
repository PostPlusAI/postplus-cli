import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { diagnosticFetch, PostPlusNetworkRequestError } from './network-diagnostics.js';
import { PostPlusFailure } from './failure-contract.js';
import { resolveApiBaseUrlState } from './local-state.js';

const HELP = `Browse stored public Meta ad snapshots. No login or credits required.
Usage:
  postplus ad-library search [--query <text>] [--brand <slug>] [--category <slug>]
    [--subcategory <slug>] [--product-type software|hardware] [--visual-format <slug>]
    [--status active|inactive|unknown] [--limit <1-50>] [--offset <0-10000>]
    [--json] [--output <result.json>]
  postplus ad-library formats [--json] [--output <result.json>]
  postplus ad-library categories [--json] [--output <result.json>]

Each filter accepts one value; different filters are combined with AND.
Results are stored snapshots, not live Meta searches. Read observed_at before
claiming an ad is currently active. Formats include guidance for applying them.
Use research run facebook-ads-library for a separately scoped fresh collection.
`;

export function parseAdLibraryCommand(args: string[]) {
  const [operation, ...tokens] = args;
  if (!['search', 'formats', 'categories'].includes(operation ?? ''))
    throw new Error('Use postplus ad-library search|formats|categories.');
  const params = new URLSearchParams();
  const seen = new Set<string>();
  let output: string | undefined;
  const filters = ['query', 'brand', 'category', 'subcategory', 'product-type', 'visual-format', 'status', 'limit', 'offset'];
  for (let i = 0; i < tokens.length; i++) {
    const flag = tokens[i]!;
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--json') continue;
    const key = flag.slice(2);
    if (!flag.startsWith('--') || !(key === 'output' || (operation === 'search' && filters.includes(key))))
      throw new Error(`Unknown ad-library option: ${flag}`);
    const value = tokens[++i];
    if (!value?.trim() || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (key === 'output') { output = value; continue; }
    if (key === 'limit' || key === 'offset') {
      const min = key === 'limit' ? 1 : 0;
      const max = key === 'limit' ? 50 : 10000;
      if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
        throw new Error(`${flag} must be an integer from ${min} to ${max}.`);
    } else if (key === 'product-type' && !['software', 'hardware'].includes(value)) {
      throw new Error('--product-type must be software or hardware.');
    } else if (key === 'status' && !['active', 'inactive', 'unknown'].includes(value)) {
      throw new Error('--status must be active, inactive, or unknown.');
    } else if (value.length > 200) throw new Error(`${flag} must be at most 200 characters.`);
    params.set(key, value.trim());
  }
  const path = operation === 'search' ? '/api/ad-library' : `/api/ad-library/${operation}`;
  return { path: `${path}${params.size ? `?${params}` : ''}`, output };
}

export async function runAdLibraryCommand(args: string[], dependencies: {
  request?: (url: URL, init: RequestInit) => Promise<Response>;
  baseUrl?: string;
  output?: (text: string) => void;
} = {}): Promise<number> {
  const print = dependencies.output ?? ((text: string) => process.stdout.write(text));
  if (!args.length || args.some(arg => ['--help', '-h', 'help'].includes(arg))) {
    print(HELP); return 0;
  }
  const command = parseAdLibraryCommand(args);
  const baseUrl = dependencies.baseUrl ?? (await resolveApiBaseUrlState()).value;
  if (!baseUrl) throw new Error('PostPlus API URL is not configured.');
  const url = new URL(command.path, baseUrl);
  let response: Response;
  try {
    response = await (dependencies.request ?? diagnosticFetch)(url, {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error instanceof PostPlusNetworkRequestError) throw error;
    throw new PostPlusFailure(`Ad library request failed at ${url.host}.`, { code: 'postplus_cli_cloud_transport_failed', stage: 'ad-library', service: 'postplus', retryable: true, method: 'GET', targetHost: url.host, action: 'Check connectivity and retry the read-only command.' });
  }
  if (!response.ok) throw new PostPlusFailure(`Ad library request failed (${response.status}) at ${url.host}.`, { code: 'postplus_ad_library_http_failed', stage: 'ad-library', service: 'postplus', httpStatus: response.status, retryable: response.status === 429 || response.status >= 500, action: 'Resolve the HTTP error before retrying this read-only command.' });
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object' || !('schemaVersion' in payload) || payload.schemaVersion !== 1 || !('items' in payload) || !Array.isArray(payload.items))
    throw new Error('Invalid ad library response: expected schemaVersion 1 and items.');
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (command.output) {
    const destination = resolve(command.output);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, destination); }
    finally { await rm(temporary, { force: true }); }
  }
  print(text);
  return 0;
}
