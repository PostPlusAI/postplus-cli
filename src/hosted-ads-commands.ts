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
export const HOSTED_ADS_QUERY_BATCH_TIMEOUT_MS = 120_000;
const MAX_BINDING_LIST_LIMIT = 100;
const MAX_MULTI_ACCOUNT_BINDINGS = 10;
const MAX_CURSOR_LENGTH = 512;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const QUERY_ID_PATTERN = /^[a-z][a-z0-9_.]{0,127}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/u;

type HostedAdsProvider = 'google' | 'meta_ads';
type HostedAdsSubcommand =
  | 'accounts'
  | 'bindings'
  | 'connections'
  | 'manifest'
  | 'query'
  | 'query-batch'
  | 'readiness';

type ParsedHostedAdsCommand = {
  body?: unknown;
  method: 'GET' | 'POST';
  pathName: string;
  provider: HostedAdsProvider;
  subcommand: HostedAdsSubcommand;
  timeoutMs: number;
};

export type HostedAdsRequestInput = {
  args: string[];
  requestJson?: Record<string, unknown>;
  auth: AuthedCloudRequestAuth;
  skillsReleaseId?: string;
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

/** Trusted-runtime counterpart to the bin command, without disk auth/files. */
export async function runHostedAdsRequest(
  input: HostedAdsRequestInput,
): Promise<unknown> {
  const [subcommand, ...rest] = input.args;
  if (!subcommand) {
    throw new Error('Ads hosted request requires a subcommand.');
  }
  const parsed = await parseHostedAdsCommand(
    subcommand,
    rest,
    DEFAULT_DEPENDENCIES,
    input.requestJson,
  );
  const response = await sendAuthedCloudRequest({
    auth: input.auth,
    ...(parsed.body === undefined ? {} : { body: parsed.body }),
    method: parsed.method,
    pathName: parsed.pathName,
    skillsReleaseId: input.skillsReleaseId ?? null,
    timeoutMs: parsed.timeoutMs,
  });
  const payload = await readJsonResponse(response);
  assertNoSessionToken(payload, new Set([input.auth.cliSessionToken]));
  if (response.ok) return payload;

  const failure = normalizeHostedAdsFailureEnvelope(payload);
  if (!failure) {
    throw new Error(
      `PostPlus hosted Ads request failed (status=${response.status}).`,
    );
  }
  throw new HostedAdsRequestError(failure);
}

async function parseHostedAdsCommand(
  rawSubcommand: string,
  args: string[],
  dependencies: HostedAdsCommandDependencies,
  injectedRequestJson?: Record<string, unknown>,
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
  if (
    (rawSubcommand === 'query' || rawSubcommand === 'query-batch') &&
    injectedRequestJson === undefined
  ) {
    allowedValueFlags.add('request');
  }
  const flags = parseStrictFlags(args, allowedValueFlags);
  const provider = flags.values.get('provider');
  if (provider === undefined) {
    throw new Error(
      `ads ${rawSubcommand} requires --provider google or meta_ads.`,
    );
  }
  if (provider !== 'google' && provider !== 'meta_ads') {
    throw new Error('Ads provider must be exact lowercase google or meta_ads.');
  }
  if (!flags.json) {
    throw new Error(`ads ${rawSubcommand} requires --json.`);
  }

  const pathPrefix = `/api/postplus-cli/hosted/ads/${provider}`;
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
    if (
      provider === 'meta_ads' &&
      (flags.values.has('limit') || flags.values.has('cursor'))
    ) {
      throw new Error('Meta Ads bindings do not accept --limit or --cursor.');
    }
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
  if (!requestPath && injectedRequestJson === undefined) {
    throw new Error(`ads ${rawSubcommand} requires --request <file>.`);
  }
  if (requestPath && injectedRequestJson !== undefined) {
    throw new Error(
      `ads ${rawSubcommand} cannot combine --request with injected request JSON.`,
    );
  }
  const requestValue =
    injectedRequestJson ?? (await dependencies.readJsonFile(requestPath!));
  const body =
    rawSubcommand === 'query-batch'
      ? normalizeQueryBatchRequest(requestValue)
      : normalizeQueryRequest(requestValue);
  return {
    body,
    method: 'POST',
    pathName: `${pathPrefix}/${rawSubcommand}`,
    provider,
    subcommand: rawSubcommand,
    timeoutMs:
      rawSubcommand === 'query-batch'
        ? HOSTED_ADS_QUERY_BATCH_TIMEOUT_MS
        : HOSTED_ADS_QUERY_TIMEOUT_MS,
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

function normalizeQueryBatchRequest(value: unknown): {
  parameters: Record<string, unknown>;
  queryId: string;
  scope:
    | { type: 'all_linked' | 'current' }
    | { bindingIds: readonly string[]; type: 'selected' };
} {
  if (!isPlainObject(value)) {
    throw new Error('ads query-batch --request must contain a JSON object.');
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'parameters' ||
    keys[1] !== 'queryId' ||
    keys[2] !== 'scope'
  ) {
    throw new Error(
      'ads query-batch --request accepts only scope, queryId, and parameters.',
    );
  }
  if (
    typeof value.queryId !== 'string' ||
    !QUERY_ID_PATTERN.test(value.queryId)
  ) {
    throw new Error('queryId must be a canonical named-query identifier.');
  }
  if (!isPlainObject(value.parameters)) {
    throw new Error('parameters must be a JSON object.');
  }
  const scope = normalizeAccountScope(value.scope);
  return Object.freeze({
    parameters: Object.freeze({ ...value.parameters }),
    queryId: value.queryId,
    scope,
  });
}

function normalizeAccountScope(
  value: unknown,
):
  | { type: 'all_linked' | 'current' }
  | { bindingIds: readonly string[]; type: 'selected' } {
  if (!isPlainObject(value) || typeof value.type !== 'string') {
    throw new Error('scope must be an explicit Ads account scope.');
  }
  const keys = Object.keys(value).sort();
  if (value.type === 'current' || value.type === 'all_linked') {
    if (keys.length !== 1 || keys[0] !== 'type') {
      throw new Error('Current and all-linked scopes accept only type.');
    }
    return Object.freeze({ type: value.type });
  }
  if (
    value.type !== 'selected' ||
    keys.length !== 2 ||
    keys[0] !== 'bindingIds' ||
    keys[1] !== 'type' ||
    !Array.isArray(value.bindingIds) ||
    value.bindingIds.length < 1 ||
    value.bindingIds.length > MAX_MULTI_ACCOUNT_BINDINGS
  ) {
    throw new Error(
      'Selected scope requires 1 to 10 unique bindingIds and type.',
    );
  }
  const bindingIds = value.bindingIds.map((bindingId) =>
    requireCanonicalUuid(bindingId, 'bindingId'),
  );
  if (new Set(bindingIds).size !== bindingIds.length) {
    throw new Error('Selected scope bindingIds must be unique.');
  }
  return Object.freeze({
    bindingIds: Object.freeze(bindingIds),
    type: 'selected' as const,
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
    value === 'query' ||
    value === 'query-batch'
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

class HostedAdsRequestError extends Error {
  readonly productError: {
    code: string;
    layer: 'ads';
    message: string;
    operationId: string;
  };

  constructor(failure: unknown) {
    const envelope = failure as {
      error: { code: string; message: string };
      requestId: string;
    };
    super(envelope.error.message);
    this.name = 'HostedAdsRequestError';
    this.productError = Object.freeze({
      code: envelope.error.code,
      layer: 'ads',
      message: envelope.error.message,
      operationId: envelope.requestId,
    });
  }
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
  postplus ads manifest --provider <google|meta_ads> --json
  postplus ads connections --provider <google|meta_ads> --json
  postplus ads accounts --provider <google|meta_ads> --json
  postplus ads bindings --provider google [--limit N] [--cursor X] --json
  postplus ads bindings --provider meta_ads --json
  postplus ads readiness --provider <google|meta_ads> --binding-id UUID --json
  postplus ads query --provider <google|meta_ads> --request <file> --json
  postplus ads query-batch --provider <google|meta_ads> --request <file> --json

These commands are read-only. Account connection, discovery, candidate selection,
and advertiser binding remain browser-owner workflows.
`);
}
