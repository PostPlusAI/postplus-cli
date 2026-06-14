import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveFreshRemoteAuth } from './auth-session.js';
import {
  buildPostPlusClientCompatibilityHeaders,
  formatPostPlusCompatibilityError,
} from './client-compatibility.js';
import {
  buildHostedRequestSchemaReport,
  buildMediaGenerationRequestDimensions,
} from './hosted-request-schemas.js';
import { HOSTED_EXECUTION_MANIFESTS } from './generated/hosted-execution-manifest.generated.js';
import {
  type LargeCreditQuoteConfirmationChallenge,
  readLargeCreditQuoteConfirmationChallenge,
} from './quote-confirmation.js';

type HostedDomain = 'media' | 'publish' | 'research';

// Generated execution manifest (SSOT projected from apps/web + public-skill-metadata).
// The verb/flag grammar, runner-managed set, and enum sets all come from here so
// the CLI never hand-maintains a mirror of the Web hosted catalog.
type ManifestField = {
  name: string;
  class: 'intent' | 'default' | 'runner-managed';
  flag: string | null;
  type: 'string' | 'number' | 'boolean' | 'media-url';
  repeatable?: boolean;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
  required: boolean;
  derivedFrom?: string;
};

type ManifestEndpoint = {
  endpointKey: string;
  fields: readonly ManifestField[];
};

type ManifestModel = {
  modelKey: string;
  providerModelPath: string;
};

type ManifestEntry = {
  skill: string;
  surface: string;
  verb: string;
  domain: string;
  capability: string;
  // media-generation entries carry `endpoints`; video-analysis entries carry
  // `models`. Each is optional so the union serializes/reads cleanly.
  endpoints?: readonly ManifestEndpoint[];
  models?: readonly ManifestModel[];
};

// A resolved (verb, target) entry. media-generation resolves to an `endpoint`;
// video-analysis resolves to a `model`. capability discriminates the two so the
// dispatcher routes to the right input surface.
type ResolvedVerbEndpoint = {
  skill: string;
  capability: string;
  surface: string;
  endpoint?: ManifestEndpoint;
  model?: ManifestModel;
};

const MEDIA_VERB_ENDPOINTS = buildMediaVerbIndex();

function buildMediaVerbIndex(): Map<string, Map<string, ResolvedVerbEndpoint>> {
  const index = new Map<string, Map<string, ResolvedVerbEndpoint>>();

  for (const entry of Object.values(
    HOSTED_EXECUTION_MANIFESTS,
  ) as unknown as ManifestEntry[]) {
    if (entry.domain !== 'media') {
      continue;
    }

    let targets = index.get(entry.verb);
    if (!targets) {
      targets = new Map<string, ResolvedVerbEndpoint>();
      index.set(entry.verb, targets);
    }

    if (entry.capability === 'video-analysis') {
      for (const model of entry.models ?? []) {
        targets.set(model.modelKey, {
          skill: entry.skill,
          capability: entry.capability,
          surface: entry.surface,
          model,
        });
      }
      continue;
    }

    for (const endpoint of entry.endpoints ?? []) {
      targets.set(endpoint.endpointKey, {
        skill: entry.skill,
        capability: entry.capability,
        surface: entry.surface,
        endpoint,
      });
    }
  }

  return index;
}

type ParsedFlags = {
  values: Map<string, string>;
  booleans: Set<string>;
  arrays: Map<string, string[]>;
};

type HostedEnvelope = {
  hostedOperationId?: unknown;
  input?: unknown;
  operationId?: unknown;
  quoteConfirmationToken?: unknown;
  schemaVersion?: unknown;
};

class HostedQuoteConfirmationRequiredError extends Error {
  constructor(
    message: string,
    readonly challenge: LargeCreditQuoteConfirmationChallenge,
  ) {
    super(message);
    this.name = 'HostedQuoteConfirmationRequiredError';
  }
}

// Structured hosted product error as returned by the Web boundary. The CLI is a
// pass-through: it must report the stable code, owning layer, and operation id
// verbatim instead of collapsing the failure to a generic message.
type HostedProductError = {
  message: string;
  code: string | null;
  layer: string | null;
  operationId: string | null;
  userMessageRule: string | null;
};

class HostedProductRequestError extends Error {
  constructor(readonly productError: HostedProductError) {
    super(formatHostedProductErrorMessage(productError));
    this.name = 'HostedProductRequestError';
  }
}

const HOSTED_DOMAIN_CAPABILITIES: Record<HostedDomain, Set<string>> = {
  media: new Set(['media-file', 'media-generation', 'video-analysis']),
  publish: new Set(['social-publishing']),
  research: new Set(['public-content-collection', 'public-content-discovery']),
};

export async function runHostedDomainCommand(
  domain: HostedDomain,
  args: string[],
): Promise<number> {
  const [subcommand, ...rest] = args;

  if (domain === 'research') {
    if (subcommand === 'schema') {
      return runHostedSchema(domain, rest);
    }
    if (subcommand === 'collect') {
      return runResearchCollect(rest);
    }
    if (subcommand === 'capability') {
      return runHostedCapability(domain, rest);
    }
    printResearchHelp();
    return subcommand === undefined || isHelp(subcommand) ? 0 : 1;
  }

  if (subcommand === 'schema') {
    return runHostedSchema(domain, rest);
  }

  if (subcommand === 'capability') {
    return runHostedCapability(domain, rest);
  }

  if (domain === 'media' && subcommand && MEDIA_VERB_ENDPOINTS.has(subcommand)) {
    return runMediaVerb(subcommand, rest);
  }

  printCapabilityHelp(domain);
  return subcommand === undefined || isHelp(subcommand) ? 0 : 1;
}

// Manifest-driven verb grammar: `postplus media <verb> <endpointKey> ...`. The
// endpoint's executionSurface decides the input shape — a flags surface maps
// scalar intent/default fields to flags, a request-json surface reads the nested
// envelope from `--request <file>`. Either way runner-managed fields (billing
// dimensions, ids, tokens) are derived/minted by the runner, never agent-supplied.
async function runMediaVerb(verb: string, args: string[]): Promise<number> {
  const targets = MEDIA_VERB_ENDPOINTS.get(verb);
  if (!targets) {
    throw new Error(`Unknown media verb ${verb}.`);
  }

  const [targetKey, ...rest] = args;
  if (!targetKey || targetKey.startsWith('--')) {
    throw new Error(
      `postplus media ${verb} requires a target key. Run \`postplus media schema --json\` to list targets.`,
    );
  }

  const resolved = targets.get(targetKey);
  if (!resolved) {
    throw new Error(
      `Unknown ${verb} target ${targetKey}. Valid: ${[...targets.keys()].join(', ')}.`,
    );
  }

  if (resolved.capability === 'video-analysis') {
    return runVideoAnalysisVerb({
      args: rest,
      modelKey: targetKey,
      resolved,
      verb,
    });
  }

  if (resolved.surface === 'request-json') {
    return runMediaVerbRequestJson({
      args: rest,
      endpointKey: targetKey,
      resolved,
      verb,
    });
  }

  return runMediaVerbFlags({
    args: rest,
    endpointKey: targetKey,
    resolved,
    verb,
  });
}

// Flags surface (e.g. audio-transcription): scalar intent/default fields map to
// flags; runner-managed fields have no flag so the agent cannot pass them.
async function runMediaVerbFlags(args: {
  args: string[];
  endpointKey: string;
  resolved: ResolvedVerbEndpoint;
  verb: string;
}): Promise<number> {
  const { endpointKey, resolved, verb } = args;
  const endpoint = requireResolvedEndpoint(resolved, verb, endpointKey);
  const fields = endpoint.fields;
  const flagToField = new Map<string, ManifestField>();
  const booleanKeys = new Set<string>(['json']);
  const arrayKeys = new Set<string>();

  for (const field of fields) {
    if (!field.flag) {
      continue;
    }
    const key = field.flag.replace(/^--/u, '');
    flagToField.set(key, field);
    if (field.type === 'boolean') {
      booleanKeys.add(key);
    }
    if (field.repeatable) {
      arrayKeys.add(key);
    }
  }

  const flags = parseFlags(args.args, booleanKeys, arrayKeys);
  const outputPath = flags.values.get('output') ?? null;
  const controlKeys = new Set([
    'hosted-operation-id',
    'json',
    'output',
    'quote-confirmation-token',
    'skill',
  ]);

  // Reject unknown flags. This is how runner-managed fields (no flag) and typos
  // are caught locally before any hosted call.
  for (const key of [
    ...flags.values.keys(),
    ...flags.booleans,
    ...flags.arrays.keys(),
  ]) {
    if (!flagToField.has(key) && !controlKeys.has(key)) {
      throw new Error(`Unknown option for media ${verb}: --${key}.`);
    }
  }

  const input = buildMediaVerbInput({
    endpointKey,
    fields,
    flags,
    verb,
  });

  return submitMediaGenerationRequest({
    capability: resolved.capability,
    endpointKey,
    errorInputLabel: `media-${verb}-${endpointKey}`,
    input,
    json: flags.booleans.has('json'),
    operationId:
      flags.values.get('hosted-operation-id') ??
      `postplus-cli:media:${resolved.capability}:request:${randomUUID()}`,
    outputPath,
    quoteConfirmationToken: flags.values.get('quote-confirmation-token'),
    skillName: flags.values.get('skill') ?? resolved.skill,
  });
}

// Request-json surface (e.g. seedance-submitter): the nested envelope is supplied
// via `--request <file>`. capability/endpointKey come from the verb + positional,
// so the body carries only the media-generation input. Runner-managed fields have
// no flag and must not appear in the body — the CLI fast-fails if they do.
async function runMediaVerbRequestJson(args: {
  args: string[];
  endpointKey: string;
  resolved: ResolvedVerbEndpoint;
  verb: string;
}): Promise<number> {
  const { endpointKey, resolved, verb } = args;
  const endpoint = requireResolvedEndpoint(resolved, verb, endpointKey);
  const flags = parseFlags(args.args, new Set(['json']));
  const allowedKeys = new Set([
    'hosted-operation-id',
    'json',
    'output',
    'quote-confirmation-token',
    'request',
    'skill',
  ]);
  for (const key of [...flags.values.keys(), ...flags.booleans]) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option for media ${verb}: --${key}.`);
    }
  }

  const requestPath = requireFlag(flags, 'request');
  const outputPath = flags.values.get('output') ?? null;
  const raw = await readJsonFile(requestPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `media ${verb} ${endpointKey} --request must be a JSON object of media-generation input.`,
    );
  }
  const input = raw as Record<string, unknown>;

  // Runner-managed fields are minted/derived by the CLI; reject them in the body so
  // the agent cannot smuggle in ids, tokens, or billing dimensions.
  for (const field of endpoint.fields) {
    if (
      field.class === 'runner-managed' &&
      Object.hasOwn(input, field.name)
    ) {
      throw new Error(
        `media ${verb} ${endpointKey} input must not include runner-managed field "${field.name}"; the CLI mints or derives it.`,
      );
    }
  }

  return submitMediaGenerationRequest({
    capability: resolved.capability,
    endpointKey,
    errorInputLabel: requestPath,
    input,
    json: flags.booleans.has('json'),
    operationId:
      flags.values.get('hosted-operation-id') ??
      `postplus-cli:media:${resolved.capability}:request:${randomUUID()}`,
    outputPath,
    quoteConfirmationToken: flags.values.get('quote-confirmation-token'),
    skillName: flags.values.get('skill') ?? resolved.skill,
  });
}

function requireResolvedEndpoint(
  resolved: ResolvedVerbEndpoint,
  verb: string,
  endpointKey: string,
): ManifestEndpoint {
  if (!resolved.endpoint) {
    throw new Error(
      `media ${verb} ${endpointKey} resolved to a non-endpoint target; this verb requires a media-generation endpoint.`,
    );
  }
  return resolved.endpoint;
}

// video-analysis verb (request-json surface). The agent authors an opaque Gemini
// request object (contents + generationConfig) in `--request <file>`; capability,
// operation, and modelKey come from the verb + positional, so the body posts
// EXACTLY the locked Web contract. There is no field classification and no
// estimatedUsage — the payload is forwarded verbatim as the Gemini request.
async function runVideoAnalysisVerb(args: {
  args: string[];
  modelKey: string;
  resolved: ResolvedVerbEndpoint;
  verb: string;
}): Promise<number> {
  const { modelKey, resolved, verb } = args;
  const flags = parseFlags(args.args, new Set(['json']));
  const allowedKeys = new Set([
    'hosted-operation-id',
    'json',
    'output',
    'quote-confirmation-token',
    'request',
    'skill',
  ]);
  for (const key of [...flags.values.keys(), ...flags.booleans]) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option for media ${verb}: --${key}.`);
    }
  }

  const requestPath = requireFlag(flags, 'request');
  const outputPath = flags.values.get('output') ?? null;
  const raw = await readJsonFile(requestPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `media ${verb} ${modelKey} --request must be a JSON object of Gemini request payload.`,
    );
  }
  const payload = raw as Record<string, unknown>;

  const body = {
    capability: 'video-analysis',
    operation: 'analyze',
    modelKey,
    payload,
    operationId:
      flags.values.get('hosted-operation-id') ??
      `postplus-cli:media:video-analysis:analyze:${randomUUID()}`,
    quoteConfirmationToken:
      flags.values.get('quote-confirmation-token') ?? undefined,
  };

  return runHostedCommand({
    request: () =>
      postHostedJson({
        body,
        pathName: '/api/postplus-cli/hosted/capability',
        skillName: flags.values.get('skill') ?? resolved.skill,
      }),
    errorInputLabel: requestPath,
    json: flags.booleans.has('json'),
    outputPath,
  });
}

// Shared submit path for both surfaces: wrap the media input, derive billing
// dimensions from endpointKey + input, and POST to the Web boundary.
function submitMediaGenerationRequest(params: {
  capability: string;
  endpointKey: string;
  errorInputLabel: string;
  input: Record<string, unknown>;
  json: boolean;
  operationId: string;
  outputPath: string | null;
  quoteConfirmationToken: string | undefined;
  skillName: string;
}): Promise<number> {
  const body = {
    capability: params.capability,
    endpointKey: params.endpointKey,
    input: params.input,
    operation: 'request',
    operationId: params.operationId,
    quoteConfirmationToken: params.quoteConfirmationToken ?? undefined,
    requestDimensions: buildMediaGenerationRequestDimensions(
      params.endpointKey,
      params.input,
    ),
  };

  return runHostedCommand({
    request: () =>
      postHostedJson({
        body,
        pathName: '/api/postplus-cli/hosted/capability',
        skillName: params.skillName,
      }),
    errorInputLabel: params.errorInputLabel,
    json: params.json,
    outputPath: params.outputPath,
  });
}

function buildMediaVerbInput(input: {
  endpointKey: string;
  fields: readonly ManifestField[];
  flags: ParsedFlags;
  verb: string;
}): Record<string, unknown> {
  const record: Record<string, unknown> = {};

  for (const field of input.fields) {
    if (field.class === 'runner-managed' || !field.flag) {
      continue;
    }

    const key = field.flag.replace(/^--/u, '');

    if (field.repeatable) {
      const list = input.flags.arrays.get(key) ?? [];
      if (list.length === 0) {
        if (field.required) {
          throw new Error(
            `Missing required option --${key} for media ${input.verb} ${input.endpointKey}.`,
          );
        }
        continue;
      }
      record[field.name] = list;
      continue;
    }

    if (field.type === 'boolean') {
      if (input.flags.booleans.has(key)) {
        record[field.name] = true;
      } else if (typeof field.default === 'boolean') {
        record[field.name] = field.default;
      }
      continue;
    }

    const raw = input.flags.values.get(key);

    if (raw === undefined) {
      if (field.class === 'default' && field.default !== undefined) {
        record[field.name] = field.default;
      } else if (field.required) {
        throw new Error(
          `Missing required option --${key} for media ${input.verb} ${input.endpointKey}.`,
        );
      }
      continue;
    }

    if (field.enumValues && !field.enumValues.includes(raw)) {
      throw new Error(
        `--${key} must be one of ${field.enumValues.join(', ')}.`,
      );
    }

    if (field.type === 'number') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--${key} must be a positive number.`);
      }
      record[field.name] = parsed;
    } else {
      record[field.name] = raw;
    }
  }

  return record;
}

async function runResearchCollect(args: string[]): Promise<number> {
  const flags = parseFlags(args, new Set(['json']));
  const runHandle = flags.values.get('run-handle');
  const outputPath = flags.values.get('output') ?? null;

  if (runHandle) {
    return runHostedCommand({
      request: () =>
        postHostedJson({
          body: { runHandle },
          pathName: '/api/postplus-cli/hosted/collection',
          skillName: null,
        }),
      errorInputLabel: 'research-collect-run-handle',
      json: flags.booleans.has('json'),
      outputPath,
    });
  }

  const skillName = requireFlag(flags, 'skill');
  const collectionKey = requireFlag(flags, 'collection-key');
  const inputPath = requireFlag(flags, 'input');
  const envelope = readHostedEnvelope(await readJsonFile(inputPath), inputPath);
  const operationId =
    flags.values.get('hosted-operation-id') ??
    normalizeString(envelope.hostedOperationId) ??
    normalizeString(envelope.operationId) ??
    `postplus-cli:research:${collectionKey}:${randomUUID()}`;
  const quoteConfirmationToken =
    flags.values.get('quote-confirmation-token') ??
    normalizeString(envelope.quoteConfirmationToken);

  // Optional per-request cost ceiling (USD) overriding the hosted default.
  const maxChargeFlag = flags.values.get('max-charge-usd');
  let maxTotalChargeUsd: number | undefined;
  if (maxChargeFlag !== undefined) {
    const parsed = Number(maxChargeFlag);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('--max-charge-usd must be a positive number of USD.');
    }
    maxTotalChargeUsd = parsed;
  }

  return runHostedCommand({
    request: () =>
      postHostedJson({
        body: {
          collectionKey,
          input: envelope.input,
          operationId,
          quoteConfirmationToken: quoteConfirmationToken ?? undefined,
          skillName,
          maxTotalChargeUsd,
        },
        pathName: '/api/postplus-cli/hosted/collection',
        skillName,
      }),
    errorInputLabel: inputPath,
    json: flags.booleans.has('json'),
    outputPath,
  });
}

async function runHostedSchema(
  domain: HostedDomain,
  args: string[],
): Promise<number> {
  const flags = parseFlags(args, new Set(['json']));
  const allowedFlags =
    domain === 'media'
      ? new Set(['endpoint'])
      : domain === 'research'
        ? new Set(['collection-key'])
        : new Set<string>();

  for (const key of flags.values.keys()) {
    if (!allowedFlags.has(key)) {
      throw new Error(`Unknown option for ${domain} schema: --${key}.`);
    }
  }

  writeJson(
    buildHostedRequestSchemaReport({
      collectionKey: flags.values.get('collection-key') ?? null,
      domain,
      endpointKey: flags.values.get('endpoint') ?? null,
    }),
  );
  return 0;
}

async function runHostedCapability(
  domain: HostedDomain,
  args: string[],
): Promise<number> {
  const flags = parseFlags(args, new Set(['json']));
  const requestPath = requireFlag(flags, 'request');
  const outputPath = flags.values.get('output') ?? null;
  const request = await readJsonFile(requestPath);

  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error(
      `Hosted ${domain} capability request must be a JSON object.`,
    );
  }

  const record = request as Record<string, unknown>;
  const capability = requireDomainCapability(record, domain);
  const operation = requireRecordString(record, 'operation');
  const operationId =
    flags.values.get('hosted-operation-id') ??
    normalizeString(record.operationId) ??
    `postplus-cli:${domain}:${capability}:${operation}:${randomUUID()}`;
  const quoteConfirmationToken =
    flags.values.get('quote-confirmation-token') ??
    normalizeString(record.quoteConfirmationToken);
  const publicRecord = { ...record };
  delete publicRecord.skillName;
  const derivedFields = buildDerivedHostedCapabilityFields({
    capability,
    domain,
    operation,
    record,
  });
  const body = {
    ...publicRecord,
    ...derivedFields,
    capability,
    operation,
    operationId,
    quoteConfirmationToken: quoteConfirmationToken ?? undefined,
  };
  const skillName =
    flags.values.get('skill') ?? normalizeString(record.skillName);
  return runHostedCommand({
    request: () =>
      postHostedJson({
        body,
        pathName: '/api/postplus-cli/hosted/capability',
        skillName,
      }),
    errorInputLabel: requestPath,
    json: flags.booleans.has('json'),
    outputPath,
  });
}

function buildDerivedHostedCapabilityFields(input: {
  capability: string;
  domain: HostedDomain;
  operation: string;
  record: Record<string, unknown>;
}): Record<string, unknown> {
  if (
    input.domain !== 'media' ||
    input.capability !== 'media-generation' ||
    input.operation !== 'request'
  ) {
    return {};
  }

  if (Object.hasOwn(input.record, 'requestDimensions')) {
    throw new Error(
      'Hosted media-generation request must not include requestDimensions. The CLI derives billing dimensions from endpointKey and input.',
    );
  }

  const endpointKey = requireRecordString(input.record, 'endpointKey');
  const mediaInput = requireRecordObject(input.record, 'input');

  return {
    requestDimensions: buildMediaGenerationRequestDimensions(
      endpointKey,
      mediaInput,
    ),
  };
}

async function postHostedJson(input: {
  body: unknown;
  pathName: string;
  skillName: string | null;
}): Promise<unknown> {
  let auth = await resolveFreshRemoteAuth();
  let response = await postJson({
    apiBaseUrl: auth.apiBaseUrl,
    body: input.body,
    cliSessionToken: auth.cliSessionToken,
    pathName: input.pathName,
    skillName: input.skillName,
  });

  if (response.status === 401) {
    auth = await resolveFreshRemoteAuth({ forceRefresh: true });
    response = await postJson({
      apiBaseUrl: auth.apiBaseUrl,
      body: input.body,
      cliSessionToken: auth.cliSessionToken,
      pathName: input.pathName,
      skillName: input.skillName,
    });
  }

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const productError = readHostedProductError(payload);
    const challenge = readLargeCreditQuoteConfirmationChallenge(payload);
    if (challenge) {
      throw new HostedQuoteConfirmationRequiredError(
        productError.message,
        challenge,
      );
    }

    const compatibilityError = formatPostPlusCompatibilityError(payload);
    if (compatibilityError) {
      throw new Error(compatibilityError);
    }
    throw new HostedProductRequestError(productError);
  }

  return payload;
}

// Single exit path for every hosted command: success writes the result and
// returns 0; a quote challenge writes the challenge file and rethrows actionable
// guidance; a structured product error writes the full error envelope to the
// result JSON and surfaces code/layer/operationId on the terminal, exiting 1.
async function runHostedCommand(input: {
  request: () => Promise<unknown>;
  errorInputLabel: string;
  json: boolean;
  outputPath: string | null;
}): Promise<number> {
  let payload: unknown;
  try {
    payload = await input.request();
  } catch (error) {
    if (error instanceof HostedQuoteConfirmationRequiredError) {
      const challengePath = await writeQuoteConfirmationChallenge(error, {
        errorInputLabel: input.errorInputLabel,
        outputPath: input.outputPath,
      });
      throw new Error(
        [
          error.message,
          `Quote confirmation challenge: ${challengePath}`,
          `Confirm: postplus quote confirm --json --challenge-file "${challengePath}"`,
          'Then rerun the hosted command with --quote-confirmation-token <token>.',
        ].join('\n'),
      );
    }

    if (error instanceof HostedProductRequestError) {
      await writeResult(
        { error: error.productError },
        input.outputPath,
        input.json,
      );
      process.stderr.write(`${error.message}\n`);
      return 1;
    }

    throw error;
  }

  await writeResult(payload, input.outputPath, input.json);
  return 0;
}

async function writeQuoteConfirmationChallenge(
  error: HostedQuoteConfirmationRequiredError,
  input: { errorInputLabel: string; outputPath: string | null },
): Promise<string> {
  const challengePath = path.resolve(
    input.outputPath
      ? `${input.outputPath}.quote-confirmation.json`
      : `${input.errorInputLabel}.quote-confirmation.json`,
  );
  await mkdir(path.dirname(challengePath), { recursive: true });
  await writeFile(
    challengePath,
    `${JSON.stringify(error.challenge, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );

  return challengePath;
}

async function postJson(input: {
  apiBaseUrl: string;
  body: unknown;
  cliSessionToken: string;
  pathName: string;
  skillName: string | null;
}): Promise<Response> {
  const headers = await buildPostPlusClientCompatibilityHeaders({
    skillName: input.skillName,
  });

  return fetch(`${input.apiBaseUrl}${input.pathName}`, {
    body: JSON.stringify(input.body),
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${input.cliSessionToken}`,
      ...headers,
      'content-type': 'application/json',
    },
    method: 'POST',
    signal: AbortSignal.timeout(120000),
  });
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('PostPlus Cloud returned invalid JSON.');
  }
}

function readHostedProductError(payload: unknown): HostedProductError {
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  return {
    message:
      normalizeString(record.error) ??
      normalizeString(record.message) ??
      'PostPlus hosted capability request failed.',
    code:
      normalizeString(record.code) ?? normalizeString(record.productErrorCode),
    layer: normalizeString(record.layer),
    operationId: normalizeString(record.operationId),
    userMessageRule: normalizeString(record.userMessageRule),
  };
}

// Terminal message that keeps the stable code, owning layer, and operation id
// visible next to the human-readable message so a failed run is locatable.
function formatHostedProductErrorMessage(
  productError: HostedProductError,
): string {
  const locator = [
    productError.code ? `code=${productError.code}` : null,
    productError.layer ? `layer=${productError.layer}` : null,
    productError.operationId ? `operationId=${productError.operationId}` : null,
  ].filter((part): part is string => part !== null);

  return locator.length > 0
    ? `${productError.message} (${locator.join(' ')})`
    : productError.message;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Failed to read JSON file ${filePath}: ${error.message}`
        : `Failed to read JSON file ${filePath}.`,
    );
  }
}

function readHostedEnvelope(value: unknown, filePath: string): HostedEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${filePath} must be a schemaVersion 1 hosted envelope.`);
  }
  const envelope = value as HostedEnvelope;
  if (envelope.schemaVersion !== 1 || !Object.hasOwn(envelope, 'input')) {
    throw new Error(`${filePath} must be a schemaVersion 1 hosted envelope.`);
  }
  return envelope;
}

async function writeResult(
  payload: unknown,
  outputPath: string | null,
  forceStdout: boolean,
): Promise<void> {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (!outputPath || forceStdout) {
    process.stdout.write(text);
  }
  if (outputPath) {
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, text);
  }
}

function parseFlags(
  args: string[],
  booleanFlags: Set<string>,
  arrayFlags: Set<string> = new Set(),
): ParsedFlags {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const arrays = new Map<string, string[]>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (booleanFlags.has(key)) {
      booleans.add(key);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}.`);
    }
    if (arrayFlags.has(key)) {
      const list = arrays.get(key) ?? [];
      list.push(value);
      arrays.set(key, list);
    } else {
      values.set(key, value);
    }
    index += 1;
  }

  return { arrays, booleans, values };
}

function requireFlag(flags: ParsedFlags, key: string): string {
  const value = flags.values.get(key);
  if (!value) {
    throw new Error(`Missing required option --${key}.`);
  }
  return value;
}

function requireDomainCapability(
  record: Record<string, unknown>,
  domain: HostedDomain,
): string {
  const capability = requireRecordString(record, 'capability');
  const allowed = HOSTED_DOMAIN_CAPABILITIES[domain];

  if (!allowed.has(capability)) {
    throw new Error(
      `Hosted ${domain} capability request uses unsupported capability ${capability}.`,
    );
  }

  return capability;
}

function requireRecordString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = normalizeString(record[key]);

  if (!value) {
    throw new Error(`Hosted capability request must include string ${key}.`);
  }

  return value;
}

function requireRecordObject(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Hosted capability request must include object ${key}.`);
  }

  return value as Record<string, unknown>;
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isHelp(value: string): boolean {
  return value === 'help' || value === '--help' || value === '-h';
}

function printResearchHelp(): void {
  process.stdout.write(`PostPlus CLI - research commands

Usage:
  postplus research schema [--collection-key <key>] [--json]
  postplus research collect --skill <skill-id> --collection-key <key> --input <hosted-envelope.json> [--max-charge-usd <usd>] [--output <result.json>]
  postplus research collect --run-handle <runHandle> [--output <result.json>]
  postplus research capability --request <hosted-capability-request.json> [--output <result.json>]
`);
}

function printCapabilityHelp(domain: Exclude<HostedDomain, 'research'>): void {
  const verbUsage =
    domain === 'media'
      ? [...MEDIA_VERB_ENDPOINTS.keys()]
          .map(
            (verb) =>
              `  postplus media ${verb} <endpoint-key> --<intent/default flags> [--json] [--output <result.json>]\n`,
          )
          .join('')
      : '';

  process.stdout.write(`PostPlus CLI - ${domain} commands

Usage:
${verbUsage}  postplus ${domain} schema${domain === 'media' ? ' [--endpoint <endpoint-key>]' : ''} [--json]
  postplus ${domain} capability --request <hosted-capability-request.json> [--output <result.json>]
`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
