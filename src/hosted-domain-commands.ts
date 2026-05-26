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
import {
  type LargeCreditQuoteConfirmationChallenge,
  readLargeCreditQuoteConfirmationChallenge,
} from './quote-confirmation.js';

type HostedDomain = 'media' | 'mobile' | 'publish' | 'research';

type ParsedFlags = {
  values: Map<string, string>;
  booleans: Set<string>;
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

const HOSTED_DOMAIN_CAPABILITIES: Record<HostedDomain, Set<string>> = {
  media: new Set(['media-file', 'media-generation', 'video-analysis']),
  mobile: new Set(['mobile-automation']),
  publish: new Set(['social-publishing']),
  research: new Set([
    'public-content-collection',
    'public-content-discovery',
  ]),
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

  printCapabilityHelp(domain);
  return subcommand === undefined || isHelp(subcommand) ? 0 : 1;
}

async function runResearchCollect(args: string[]): Promise<number> {
  const flags = parseFlags(args, new Set(['json']));
  const runHandle = flags.values.get('run-handle');
  const outputPath = flags.values.get('output') ?? null;

  if (runHandle) {
    const payload = await postHostedJson({
      body: { runHandle },
      pathName: '/api/postplus-cli/hosted/collection',
      skillName: null,
    });
    await writeResult(payload, outputPath, flags.booleans.has('json'));
    return 0;
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

  const payload = await postHostedJson({
    body: {
      collectionKey,
      input: envelope.input,
      operationId,
      quoteConfirmationToken: quoteConfirmationToken ?? undefined,
      skillName,
    },
    pathName: '/api/postplus-cli/hosted/collection',
    skillName,
  }).catch((error: unknown) =>
    buildHostedCommandError(error, {
      inputPath,
      outputPath,
    }),
  );

  await writeResult(payload, outputPath, flags.booleans.has('json'));
  return 0;
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
    throw new Error(`Hosted ${domain} capability request must be a JSON object.`);
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
  const skillName = flags.values.get('skill') ?? normalizeString(record.skillName);
  const payload = await postHostedJson({
    body,
    pathName: '/api/postplus-cli/hosted/capability',
    skillName,
  }).catch((error: unknown) =>
    buildHostedCommandError(error, {
      inputPath: requestPath,
      outputPath,
    }),
  );

  await writeResult(payload, outputPath, flags.booleans.has('json'));
  return 0;
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
    const challenge = readLargeCreditQuoteConfirmationChallenge(payload);
    if (challenge) {
      throw new HostedQuoteConfirmationRequiredError(
        readProductError(payload),
        challenge,
      );
    }

    const compatibilityError = formatPostPlusCompatibilityError(payload);
    if (compatibilityError) {
      throw new Error(compatibilityError);
    }
    throw new Error(readProductError(payload));
  }

  return payload;
}

async function buildHostedCommandError(
  error: unknown,
  input: {
    inputPath: string;
    outputPath: string | null;
  },
): Promise<never> {
  if (!(error instanceof HostedQuoteConfirmationRequiredError)) {
    throw error;
  }

  const challengePath = path.resolve(
    input.outputPath
      ? `${input.outputPath}.quote-confirmation.json`
      : `${input.inputPath}.quote-confirmation.json`,
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

  throw new Error(
    [
      error.message,
      `Quote confirmation challenge: ${challengePath}`,
      `Confirm: postplus quote confirm --json --challenge-file "${challengePath}"`,
      'Then rerun the hosted command with --quote-confirmation-token <token>.',
    ].join('\n'),
  );
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

function readProductError(payload: unknown): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error.trim();
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message.trim();
    }
  }
  return 'PostPlus hosted capability request failed.';
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

function parseFlags(args: string[], booleanFlags: Set<string>): ParsedFlags {
  const values = new Map<string, string>();
  const booleans = new Set<string>();

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
    values.set(key, value);
    index += 1;
  }

  return { booleans, values };
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
  postplus research collect --skill <skill-id> --collection-key <key> --input <hosted-envelope.json> [--output <result.json>]
  postplus research collect --run-handle <runHandle> [--output <result.json>]
  postplus research capability --request <hosted-capability-request.json> [--output <result.json>]
`);
}

function printCapabilityHelp(domain: Exclude<HostedDomain, 'research'>): void {
  process.stdout.write(`PostPlus CLI - ${domain} commands

Usage:
  postplus ${domain} schema${domain === 'media' ? ' [--endpoint <endpoint-key>]' : ''} [--json]
  postplus ${domain} capability --request <hosted-capability-request.json> [--output <result.json>]
`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
