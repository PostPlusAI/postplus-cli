import { readFile } from 'node:fs/promises';

import { resolveFreshRemoteAuth } from './auth-session.js';
import {
  type AuthedCloudRequestAuth,
  type AuthedCloudRequestInput,
  sendAuthedCloudRequest,
} from './authed-cloud-request.js';
import { formatPostPlusCompatibilityError } from './client-compatibility.js';

const HOSTED_ADS_DIAGNOSTIC_TIMEOUT_MS = 30_000;
export const HOSTED_ADS_QUERY_TIMEOUT_MS = 45_000;
const MAX_BINDING_LIST_LIMIT = 100;
const MAX_CURSOR_LENGTH = 512;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const QUERY_ID_PATTERN = /^[a-z][a-z0-9_.]{0,127}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/u;

type HostedAdsProvider = 'google';
type HostedAdsSubcommand =
  | 'accounts'
  | 'bindings'
  | 'connections'
  | 'manifest'
  | 'query'
  | 'readiness';

type ParsedHostedAdsCommand = {
  body?: unknown;
  method: 'GET' | 'POST';
  pathName: string;
  provider: HostedAdsProvider;
  subcommand: HostedAdsSubcommand;
  timeoutMs: number;
};

export type HostedAdsCommandDependencies = {
  readJsonFile(filePath: string): Promise<unknown>;
  resolveAuth(options?: {
    forceRefresh?: boolean;
  }): Promise<AuthedCloudRequestAuth>;
  sendRequest(input: AuthedCloudRequestInput): Promise<Response>;
  writeJson(value: unknown): void;
};

const DEFAULT_DEPENDENCIES: HostedAdsCommandDependencies = {
  readJsonFile,
  resolveAuth: resolveFreshRemoteAuth,
  sendRequest: sendAuthedCloudRequest,
  writeJson(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  },
};

export async function runHostedAdsCommand(
  args: string[],
  dependencyOverrides: Partial<HostedAdsCommandDependencies> = {},
): Promise<number> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const [subcommand] = args;

  if (
    subcommand === undefined ||
    subcommand === 'help' ||
    subcommand === '--help' ||
    subcommand === '-h'
  ) {
    printHostedAdsHelp();
    return 0;
  }

  const parsed = await parseHostedAdsCommand(
    subcommand,
    args.slice(1),
    dependencies,
  );
  const protectedTokens = new Set<string>();
  const resolveAuth: HostedAdsCommandDependencies['resolveAuth'] = async (
    options,
  ) => {
    const auth = await dependencies.resolveAuth(options);
    protectedTokens.add(auth.cliSessionToken);
    return auth;
  };
  const response = await dependencies.sendRequest({
    auth: await resolveAuth(),
    ...(parsed.body === undefined ? {} : { body: parsed.body }),
    method: parsed.method,
    pathName: parsed.pathName,
    retryOn401: () => resolveAuth({ forceRefresh: true }),
    timeoutMs: parsed.timeoutMs,
  });
  const payload = await readJsonResponse(response);

  assertNoSessionToken(payload, protectedTokens);
  if (!response.ok) {
    const compatibilityError = formatPostPlusCompatibilityError(payload);
    if (compatibilityError) {
      throw new Error(compatibilityError);
    }

    const errorEnvelope = normalizeHostedAdsFailureEnvelope(payload);
    if (!errorEnvelope) {
      throw new Error(
        `PostPlus hosted Ads request failed (status=${response.status}).`,
      );
    }
    dependencies.writeJson(errorEnvelope);
    return 1;
  }

  dependencies.writeJson(payload);
  return 0;
}

async function parseHostedAdsCommand(
  rawSubcommand: string,
  args: string[],
  dependencies: HostedAdsCommandDependencies,
): Promise<ParsedHostedAdsCommand> {
  if (!isHostedAdsSubcommand(rawSubcommand)) {
    throw new Error(`Unknown ads command: ${rawSubcommand}`);
  }
  const allowedValueFlags = new Set<string>(['provider']);
  if (rawSubcommand === 'bindings') {
    allowedValueFlags.add('cursor');
    allowedValueFlags.add('limit');
  }
  if (rawSubcommand === 'readiness') {
    allowedValueFlags.add('binding-id');
  }
  if (rawSubcommand === 'query') {
    allowedValueFlags.add('request');
  }
  const flags = parseStrictFlags(args, allowedValueFlags);
  const provider = flags.values.get('provider');
  if (provider === undefined) {
    throw new Error(`ads ${rawSubcommand} requires --provider google.`);
  }
  if (provider !== 'google') {
    throw new Error('Ads provider must be exact lowercase google.');
  }
  if (!flags.json) {
    throw new Error(`ads ${rawSubcommand} requires --json.`);
  }

  const pathPrefix = '/api/postplus-cli/hosted/ads/google';
  if (
    rawSubcommand === 'manifest' ||
    rawSubcommand === 'connections' ||
    rawSubcommand === 'accounts'
  ) {
    return {
      method: 'GET',
      pathName: `${pathPrefix}/${rawSubcommand}`,
      provider,
      subcommand: rawSubcommand,
      timeoutMs: HOSTED_ADS_DIAGNOSTIC_TIMEOUT_MS,
    };
  }

  if (rawSubcommand === 'bindings') {
    const query = new URLSearchParams();
    const rawLimit = flags.values.get('limit');
    if (rawLimit !== undefined) {
      const limit = Number(rawLimit);
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > MAX_BINDING_LIST_LIMIT ||
        String(limit) !== rawLimit
      ) {
        throw new Error('--limit must be a canonical integer from 1 to 100.');
      }
      query.set('limit', rawLimit);
    }
    const cursor = flags.values.get('cursor');
    if (cursor !== undefined) {
      if (
        cursor.length === 0 ||
        cursor.length > MAX_CURSOR_LENGTH ||
        !CURSOR_PATTERN.test(cursor)
      ) {
        throw new Error('--cursor must be a base64url value up to 512 chars.');
      }
      query.set('cursor', cursor);
    }
    const suffix = query.toString();
    return {
      method: 'GET',
      pathName: `${pathPrefix}/bindings${suffix ? `?${suffix}` : ''}`,
      provider,
      subcommand: rawSubcommand,
      timeoutMs: HOSTED_ADS_DIAGNOSTIC_TIMEOUT_MS,
    };
  }

  if (rawSubcommand === 'readiness') {
    const bindingId = requireCanonicalUuid(
      flags.values.get('binding-id'),
      '--binding-id',
    );
    return {
      method: 'GET',
      pathName: `${pathPrefix}/bindings/${bindingId}/readiness`,
      provider,
      subcommand: rawSubcommand,
      timeoutMs: HOSTED_ADS_DIAGNOSTIC_TIMEOUT_MS,
    };
  }

  const requestPath = flags.values.get('request');
  if (!requestPath) {
    throw new Error('ads query requires --request <file>.');
  }
  const body = normalizeQueryRequest(
    await dependencies.readJsonFile(requestPath),
  );
  return {
    body,
    method: 'POST',
    pathName: `${pathPrefix}/query`,
    provider,
    subcommand: rawSubcommand,
    timeoutMs: HOSTED_ADS_QUERY_TIMEOUT_MS,
  };
}

function parseStrictFlags(
  args: string[],
  allowedValueFlags: ReadonlySet<string>,
): { json: true | false; values: Map<string, string> } {
  const values = new Map<string, string>();
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      if (json) throw new Error('Duplicate option: --json.');
      json = true;
      continue;
    }
    if (!argument?.startsWith('--')) {
      throw new Error(`Unexpected ads argument: ${argument ?? ''}.`);
    }
    const key = argument.slice(2);
    if (!allowedValueFlags.has(key)) {
      throw new Error(`Unknown option for ads: --${key}.`);
    }
    if (values.has(key)) {
      throw new Error(`Duplicate option: --${key}.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}.`);
    }
    values.set(key, value);
    index += 1;
  }

  return { json, values };
}

function normalizeQueryRequest(value: unknown): {
  bindingId: string;
  parameters: Record<string, unknown>;
  queryId: string;
} {
  if (!isPlainObject(value)) {
    throw new Error('ads query --request must contain a JSON object.');
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'bindingId' ||
    keys[1] !== 'parameters' ||
    keys[2] !== 'queryId'
  ) {
    throw new Error(
      'ads query --request accepts only bindingId, queryId, and parameters.',
    );
  }
  const bindingId = requireCanonicalUuid(value.bindingId, 'bindingId');
  if (
    typeof value.queryId !== 'string' ||
    !QUERY_ID_PATTERN.test(value.queryId)
  ) {
    throw new Error('queryId must be a canonical named-query identifier.');
  }
  if (!isPlainObject(value.parameters)) {
    throw new Error('parameters must be a JSON object.');
  }
  return Object.freeze({
    bindingId,
    parameters: Object.freeze({ ...value.parameters }),
    queryId: value.queryId,
  });
}

function requireCanonicalUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CANONICAL_UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical lowercase UUID.`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHostedAdsSubcommand(value: string): value is HostedAdsSubcommand {
  return (
    value === 'manifest' ||
    value === 'connections' ||
    value === 'accounts' ||
    value === 'bindings' ||
    value === 'readiness' ||
    value === 'query'
  );
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    throw new Error(`Could not read valid JSON from Ads request file.`);
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('PostPlus Cloud returned invalid JSON.');
  }
}

function normalizeHostedAdsFailureEnvelope(payload: unknown): unknown | null {
  if (!isPlainObject(payload) || !isPlainObject(payload.error)) return null;
  const { error } = payload;
  if (
    payload.ok !== false ||
    payload.namespace !== 'ads' ||
    payload.schemaVersion !== 1 ||
    typeof payload.requestId !== 'string' ||
    !payload.requestId.trim() ||
    typeof error.code !== 'string' ||
    !error.code.trim() ||
    typeof error.message !== 'string' ||
    !error.message.trim() ||
    typeof error.retryable !== 'boolean' ||
    !Number.isInteger(error.status)
  ) {
    return null;
  }
  return Object.freeze({
    error: Object.freeze({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      status: error.status,
    }),
    namespace: 'ads',
    ok: false,
    requestId: payload.requestId,
    schemaVersion: 1,
  });
}

function assertNoSessionToken(
  payload: unknown,
  protectedTokens: ReadonlySet<string>,
): void {
  const serialized = JSON.stringify(payload);
  for (const token of protectedTokens) {
    if (token && serialized.includes(token)) {
      throw new Error('PostPlus Cloud returned an unsafe Ads response.');
    }
  }
}

function printHostedAdsHelp(): void {
  process.stdout.write(`PostPlus CLI — read-only Ads commands

Usage:
  postplus ads manifest --provider google --json
  postplus ads connections --provider google --json
  postplus ads accounts --provider google --json
  postplus ads bindings --provider google [--limit N] [--cursor X] --json
  postplus ads readiness --provider google --binding-id UUID --json
  postplus ads query --provider google --request <file> --json

These commands are read-only. Account connection, discovery, candidate selection,
and advertiser binding remain browser-owner workflows.
`);
}
