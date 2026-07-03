import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveFreshRemoteAuth } from './auth-session.js';
import {
  type AuthedCloudRequestAuth,
  sendAuthedCloudRequest,
} from './authed-cloud-request.js';
import { formatPostPlusCompatibilityError } from './client-compatibility.js';
import { assertModelledFieldValuesInRange } from './hosted-field-validation.js';
import {
  type HostedDomain,
  type ManifestEndpoint,
  type ManifestField,
  type ResolvedVerbTarget,
  buildVerbTargetIndex,
} from './hosted-manifest-index.js';
import { buildHostedRequestSchemaReport } from './hosted-request-schemas.js';
import {
  type LargeCreditQuoteConfirmationChallenge,
  readLargeCreditQuoteConfirmationChallenge,
} from './quote-confirmation.js';

// Manifest-driven verb grammar indexes (SSOT projected from apps/web +
// public-skill-metadata via the generated manifest). The verb/flag grammar,
// runner-managed set, and enum sets all come from the manifest so the CLI never
// hand-maintains a mirror of the Web hosted catalog.
const MEDIA_VERB_ENDPOINTS = buildVerbTargetIndex('media');
const RESEARCH_VERB_TARGETS = buildVerbTargetIndex('research');
const PUBLISH_VERB_OPERATIONS = buildPublishVerbIndex();

// Publish flattens to operation -> resolved target: the publish OPERATION is both
// the subcommand and the target (no separate positional), unlike media/research.
function buildPublishVerbIndex(): Map<string, ResolvedVerbTarget> {
  const index = new Map<string, ResolvedVerbTarget>();
  for (const targets of buildVerbTargetIndex('publish').values()) {
    for (const [operation, resolved] of targets) {
      index.set(operation, resolved);
    }
  }
  return index;
}

type ParsedFlags = {
  values: Map<string, string>;
  booleans: Set<string>;
  arrays: Map<string, string[]>;
};

// In-process execution context for the hosted-lib path (src/hosted-lib.ts). When
// present it makes the SAME resolve/dispatch core run without any disk or
// filesystem touch: the POST uses the injected `auth` + `skillsReleaseId` instead
// of `resolveFreshRemoteAuth()`/disk config, the request-json surfaces read the
// envelope from the injected `requestJson` object instead of a `--request <file>`,
// and runHostedCommand returns the parsed payload (throwing the structured errors)
// instead of writing stdout/file/exit-code. When the context is `undefined`
// (the bin path) every code path keeps its current disk/file/stdout behavior.
export type HostedRequestContext = {
  auth: AuthedCloudRequestAuth;
  skillsReleaseId?: string;
  /**
   * The request-json envelope injected in place of a `--request <file>` read.
   * Surfaces that need a body assert it is present and the right shape (object vs
   * array) exactly as the file-read path validated the parsed file contents.
   */
  requestJson?: Record<string, unknown> | unknown[];
};

// Reads the request-json body for a surface: from the injected object (lib path)
// or by reading `--request <file>` (bin path). This is the SINGLE place the two
// paths diverge on input source; the resolved body then flows through the SAME
// validation + envelope build, so the URL/body/headers stay byte-identical.
async function resolveRequestBody(
  context: HostedRequestContext | undefined,
  flags: ParsedFlags,
): Promise<{ body: unknown; errorInputLabel: string }> {
  if (context) {
    if (context.requestJson === undefined) {
      throw new Error('This hosted command requires a requestJson body.');
    }
    return { body: context.requestJson, errorInputLabel: 'requestJson' };
  }
  const requestPath = requireFlag(flags, 'request');
  return { body: await readJsonFile(requestPath), errorInputLabel: requestPath };
}

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

export async function runHostedDomainCommand(
  domain: HostedDomain,
  args: string[],
  // Present only on the in-process hosted-lib path; the bin path never passes it.
  // See HostedRequestContext: it carries the injected auth/releaseId/requestJson
  // and switches every leaf onto the no-disk, no-file, return-payload behavior.
  context?: HostedRequestContext,
): Promise<number | unknown> {
  const [subcommand, ...rest] = args;

  if (domain === 'research') {
    if (subcommand === 'schema') {
      return runHostedSchema(domain, rest, context);
    }
    if (subcommand === 'collect') {
      return runResearchCollect(rest, context);
    }
    if (subcommand === 'scrape') {
      return runResearchScrape(rest, context);
    }
    printResearchHelp();
    return subcommand === undefined || isHelp(subcommand) ? 0 : 1;
  }

  if (subcommand === 'schema') {
    return runHostedSchema(domain, rest, context);
  }

  // Poll a pending async media-generation run by handle. This is a hand-coded
  // branch (not a manifest verb) because a status poll has no endpointKey/field
  // contract to project — exactly like the `research collect --run-handle`
  // polling branch. It must be checked before the manifest verb dispatch.
  if (domain === 'media' && subcommand === 'poll') {
    return runMediaPoll(rest, context);
  }

  // Quote-only dry-run price: `postplus media estimate <endpoint-key> ...`. Takes
  // the SAME flags/--request as `media create/transcribe <endpoint-key>`, builds
  // the SAME canonical input, but posts to the estimate boundary which prices
  // without reserving. Checked before the verb dispatch (estimate is not a
  // manifest verb — it is a hand-coded pricing branch, like poll).
  if (domain === 'media' && subcommand === 'estimate') {
    return runMediaEstimate(rest, context);
  }

  if (
    domain === 'media' &&
    subcommand &&
    MEDIA_VERB_ENDPOINTS.has(subcommand)
  ) {
    return runMediaVerb(subcommand, rest, context);
  }

  // publish: the OPERATION is the subcommand (no separate target positional).
  if (
    domain === 'publish' &&
    subcommand &&
    PUBLISH_VERB_OPERATIONS.has(subcommand)
  ) {
    return runPublishOperation(subcommand, rest, context);
  }

  printDomainVerbHelp(domain);
  return subcommand === undefined || isHelp(subcommand) ? 0 : 1;
}

// Manifest-driven verb grammar: `postplus media <verb> <endpointKey> ...`. The
// endpoint's executionSurface decides the input shape — a flags surface maps
// scalar intent/default fields to flags, a request-json surface reads the nested
// envelope from `--request <file>`. Either way runner-managed fields (billing
// dimensions, ids, tokens) are derived/minted by the runner, never agent-supplied.
async function runMediaVerb(
  verb: string,
  args: string[],
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
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

  // `postplus media <verb> <endpoint> --help`: render the endpoint's field-level
  // contract (intent / default / runner-managed) instead of dispatching a request.
  if (rest.some(isHelp)) {
    printMediaEndpointHelp('media', verb, targetKey, resolved);
    return 0;
  }

  if (resolved.capability === 'video-analysis') {
    return runVideoAnalysisVerb({
      args: rest,
      modelKey: targetKey,
      resolved,
      verb,
      context,
    });
  }

  if (resolved.surface === 'request-json') {
    return runMediaVerbRequestJson({
      args: rest,
      endpointKey: targetKey,
      resolved,
      verb,
      context,
    });
  }

  return runMediaVerbFlags({
    args: rest,
    endpointKey: targetKey,
    resolved,
    verb,
    context,
  });
}

// Flags surface (e.g. audio-transcription): scalar intent/default fields map to
// flags; runner-managed fields have no flag so the agent cannot pass them.
async function runMediaVerbFlags(args: {
  args: string[];
  endpointKey: string;
  resolved: ResolvedVerbTarget;
  verb: string;
  context: HostedRequestContext | undefined;
}): Promise<number | unknown> {
  const { endpointKey, resolved, verb, context } = args;
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

  // Schema-driven early validation reads the manifest enum/range + canonicalize hint
  // for every modelled field (a single source shared with the Web boundary, which
  // stays authoritative). It runs on the built input so a mixed-case "4K"/"High"
  // passes while an out-of-enum value fast-fails locally before the hosted call.
  assertModelledFieldValuesInRange(endpointKey, fields, input);

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
    context,
  });
}

// Request-json surface (e.g. seedance-submitter): the nested envelope is supplied
// via `--request <file>`. capability/endpointKey come from the verb + positional,
// so the body carries only the media-generation input. Runner-managed fields have
// no flag and must not appear in the body — the CLI fast-fails if they do.
async function runMediaVerbRequestJson(args: {
  args: string[];
  endpointKey: string;
  resolved: ResolvedVerbTarget;
  verb: string;
  context: HostedRequestContext | undefined;
}): Promise<number | unknown> {
  const { endpointKey, resolved, verb, context } = args;
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

  const outputPath = flags.values.get('output') ?? null;
  const { body: raw, errorInputLabel } = await resolveRequestBody(
    context,
    flags,
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `media ${verb} ${endpointKey} --request must be a JSON object of media-generation input.`,
    );
  }
  const input = raw as Record<string, unknown>;

  // Runner-managed fields are minted/derived by the CLI; reject them in the body so
  // the agent cannot smuggle in ids, tokens, or billing dimensions.
  for (const field of endpoint.fields) {
    if (field.class === 'runner-managed' && Object.hasOwn(input, field.name)) {
      throw new Error(
        `media ${verb} ${endpointKey} input must not include runner-managed field "${field.name}"; the CLI mints or derives it.`,
      );
    }
  }

  // Schema-driven early validation reads the manifest enum/range + canonicalize hint
  // for every modelled field (a single source shared with the Web boundary, which
  // stays authoritative). It runs on the agent-authored body so an out-of-enum
  // resolution ("999p") fast-fails locally before the hosted call while a mixed-case
  // "720P" passes.
  assertModelledFieldValuesInRange(endpointKey, endpoint.fields, input);

  return submitMediaGenerationRequest({
    capability: resolved.capability,
    endpointKey,
    errorInputLabel,
    input,
    json: flags.booleans.has('json'),
    operationId:
      flags.values.get('hosted-operation-id') ??
      `postplus-cli:media:${resolved.capability}:request:${randomUUID()}`,
    outputPath,
    quoteConfirmationToken: flags.values.get('quote-confirmation-token'),
    skillName: flags.values.get('skill') ?? resolved.skill,
    context,
  });
}

function requireResolvedEndpoint(
  resolved: ResolvedVerbTarget,
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
// EXACTLY the locked Web contract. There is no field classification; the payload
// is forwarded verbatim as the Gemini request. The optional `--video-seconds`
// flag is the one runner-supplied hint: when provided it is sent as
// `estimatedUsage.videoSeconds` so the Web boundary can route eligible short
// videos through its preflight/routing path (omit it to use the default route).
async function runVideoAnalysisVerb(args: {
  args: string[];
  modelKey: string;
  resolved: ResolvedVerbTarget;
  verb: string;
  context: HostedRequestContext | undefined;
}): Promise<number | unknown> {
  const { modelKey, resolved, verb, context } = args;
  const flags = parseFlags(args.args, new Set(['json']));
  const allowedKeys = new Set([
    'hosted-operation-id',
    'json',
    'output',
    'quote-confirmation-token',
    'request',
    'skill',
    'video-seconds',
  ]);
  for (const key of [...flags.values.keys(), ...flags.booleans]) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option for media ${verb}: --${key}.`);
    }
  }

  const outputPath = flags.values.get('output') ?? null;
  const { body: raw, errorInputLabel } = await resolveRequestBody(
    context,
    flags,
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `media ${verb} ${modelKey} --request must be a JSON object of Gemini request payload.`,
    );
  }
  const payload = raw as Record<string, unknown>;

  // Optional runner-supplied hint: the source video duration. When provided it is
  // forwarded as estimatedUsage.videoSeconds so the Web boundary's video-analysis
  // routing/preflight can consider eligible short videos; omitting it leaves the
  // request on the default route. The CLI does not probe the media itself (no
  // ffprobe in the open-source runner) — it only passes a value the caller knows.
  const videoSecondsFlag = flags.values.get('video-seconds') ?? null;
  let estimatedUsage: { videoSeconds: number } | undefined;
  if (videoSecondsFlag !== null) {
    const parsed = Number(videoSecondsFlag);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `media ${verb} --video-seconds must be a positive number of seconds.`,
      );
    }
    estimatedUsage = { videoSeconds: parsed };
  }

  const body = {
    capability: 'video-analysis',
    operation: 'analyze',
    modelKey,
    payload,
    ...(estimatedUsage ? { estimatedUsage } : {}),
    operationId:
      flags.values.get('hosted-operation-id') ??
      `postplus-cli:media:video-analysis:analyze:${randomUUID()}`,
    quoteConfirmationToken:
      flags.values.get('quote-confirmation-token') ?? undefined,
  };

  return dispatchHostedCommand(
    {
      request: () =>
        postHostedJson({
          body,
          pathName: '/api/postplus-cli/hosted/capability',
          skillName: flags.values.get('skill') ?? resolved.skill,
          context,
        }),
      errorInputLabel,
      json: flags.booleans.has('json'),
      outputPath,
    },
    context,
  );
}

// `media-file upload`: the generic local-file -> hosted media verb. Released
// skills ship no scripts, so a skill that must place a local file behind hosted
// media first drives it through this verb. It is capability-generic: it knows no
// skill request payload. The runner asks the Web boundary for a signed upload
// target, PUTs bytes outside the JSON envelope, then asks the hosted provider
// upload operation for the reusable provider-facing result.
const MEDIA_FILE_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

function inferUploadMimeType(filePath: string): string {
  return (
    MEDIA_FILE_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ??
    'application/octet-stream'
  );
}

export async function runMediaFileCommand(
  args: string[],
  context?: HostedRequestContext,
): Promise<number | unknown> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'upload') {
    return runMediaFileUpload(rest, context);
  }
  printMediaFileHelp();
  return subcommand === undefined || isHelp(subcommand) ? 0 : 1;
}

async function runMediaFileUpload(
  args: string[],
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
  const flags = parseFlags(args, new Set(['json']));
  const allowedKeys = new Set([
    'hosted-operation-id',
    'input-file',
    'json',
    'mime',
    'output',
    'quote-confirmation-token',
    'skill',
  ]);
  for (const key of [...flags.values.keys(), ...flags.booleans]) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option for media-file upload: --${key}.`);
    }
  }

  const inputFile = requireFlag(flags, 'input-file');
  const absolutePath = path.resolve(inputFile);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw new Error(`media-file upload source is not a file: ${absolutePath}`);
  }
  const mimeType =
    flags.values.get('mime') ?? inferUploadMimeType(absolutePath);
  const outputPath = flags.values.get('output') ?? null;
  const hostedOperationId = flags.values.get('hosted-operation-id') ?? null;

  const body = {
    capability: 'media-file',
    operation: 'create-upload-url',
    file: {
      mimeType,
      name: path.basename(absolutePath),
      sizeBytes: fileStat.size,
    },
    operationId:
      hostedOperationId ??
      `postplus-cli:media-file:create-upload-url:${randomUUID()}`,
    quoteConfirmationToken:
      flags.values.get('quote-confirmation-token') ?? undefined,
  };

  return dispatchHostedCommand(
    {
      request: async () => {
        const payload = await postHostedJson({
          body,
          pathName: '/api/postplus-cli/hosted/capability',
          skillName: flags.values.get('skill') ?? null,
          context,
        });
        const output = readHostedUploadOutput(payload);
        const signedUpload = readSignedUpload(output);
        const storageReference = readStorageReferenceValue(output);
        await putHostedMediaBytes(signedUpload, absolutePath);

        return await postHostedJson({
          body: {
            capability: 'media-file',
            operation: 'upload',
            file: {
              mimeType,
              name: path.basename(absolutePath),
              storageReference,
            },
            operationId: hostedOperationId
              ? `${hostedOperationId}:upload`
              : `postplus-cli:media-file:upload:${randomUUID()}`,
            quoteConfirmationToken:
              flags.values.get('quote-confirmation-token') ?? undefined,
          },
          pathName: '/api/postplus-cli/hosted/capability',
          skillName: flags.values.get('skill') ?? null,
          context,
        });
      },
      errorInputLabel: inputFile,
      json: flags.booleans.has('json'),
      outputPath,
    },
    context,
  );
}

type SignedUpload = {
  method: string;
  requiredHeaders: Record<string, string>;
  url: string;
};

function readHostedUploadOutput(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const output = (payload as Record<string, unknown>).output;
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      return output as Record<string, unknown>;
    }
  }
  throw new Error('Hosted media upload response is missing output.');
}

function readSignedUpload(output: Record<string, unknown>): SignedUpload {
  const signedUpload = output.signedUpload;
  if (
    !signedUpload ||
    typeof signedUpload !== 'object' ||
    Array.isArray(signedUpload)
  ) {
    throw new Error('Hosted media upload response is missing signedUpload.');
  }
  const record = signedUpload as Record<string, unknown>;
  if (typeof record.url !== 'string' || !record.url.trim()) {
    throw new Error('Hosted media upload signedUpload.url must be a string.');
  }
  if (record.method !== 'PUT') {
    throw new Error(
      `Unsupported hosted media signed upload method: ${String(record.method)}.`,
    );
  }
  const requiredHeaders: Record<string, string> = {};
  if (
    record.requiredHeaders &&
    typeof record.requiredHeaders === 'object' &&
    !Array.isArray(record.requiredHeaders)
  ) {
    for (const [key, value] of Object.entries(
      record.requiredHeaders as Record<string, unknown>,
    )) {
      if (typeof value !== 'string') {
        throw new Error(
          `Hosted media upload signedUpload.requiredHeaders.${key} must be a string.`,
        );
      }
      requiredHeaders[key] = value;
    }
  }
  return { method: record.method, requiredHeaders, url: record.url.trim() };
}

function readStorageReferenceValue(output: Record<string, unknown>): unknown {
  const storageReference = output.storageReference;
  if (
    !storageReference ||
    typeof storageReference !== 'object' ||
    Array.isArray(storageReference)
  ) {
    throw new Error(
      'Hosted media upload response is missing storageReference.',
    );
  }
  return storageReference;
}

async function putHostedMediaBytes(
  signedUpload: SignedUpload,
  absolutePath: string,
): Promise<void> {
  const response = await fetch(signedUpload.url, {
    body: createReadStream(absolutePath),
    duplex: 'half',
    headers: signedUpload.requiredHeaders,
    method: 'PUT',
    signal: AbortSignal.timeout(120000),
  } as RequestInit & { duplex: 'half' });
  if (!response.ok) {
    throw new Error(
      `Hosted media signed upload failed with status ${response.status}.`,
    );
  }
}

function printMediaFileHelp(): void {
  process.stdout.write(`PostPlus CLI - media-file commands

Usage:
  postplus media-file upload --input-file <path> [--mime <type>] [--skill <skill-id>] [--json] [--output <result.json>]
`);
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
  context: HostedRequestContext | undefined;
}): Promise<number | unknown> {
  // Billing dimensions are derived solely at the Web boundary from
  // (endpointKey, input); the CLI sends only the payload. The Web request schema
  // rejects any caller-supplied `requestDimensions` (single source of truth).
  const body = {
    capability: params.capability,
    endpointKey: params.endpointKey,
    input: params.input,
    operation: 'request',
    operationId: params.operationId,
    quoteConfirmationToken: params.quoteConfirmationToken ?? undefined,
  };

  return dispatchHostedCommand(
    {
      request: () =>
        postHostedJson({
          body,
          pathName: '/api/postplus-cli/hosted/capability',
          skillName: params.skillName,
          context: params.context,
        }),
      errorInputLabel: params.errorInputLabel,
      json: params.json,
      outputPath: params.outputPath,
    },
    params.context,
  );
}

// Poll a pending media-generation run: `postplus media poll --handle <run-id>`.
// A media `create`/`transcribe`/`analyze` submit returns an async run handle
// (`output.data.id`, also surfaced as `output.data.urls.get`) while the provider
// job is still processing. This resumes that run by handle against the
// media-generation `operation: 'status'` boundary. It is read-only and
// billing-idempotent: the Web boundary finds the run by handle and settlement
// reuses the submit's operationId, so polling never re-reserves or re-charges.
// The body carries only the status quadruple; submit-only fields (input,
// requestDimensions, quoteConfirmationToken) are never sent. Mirrors the
// `research collect --run-handle` polling branch.
async function runMediaPoll(
  args: string[],
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
  const flags = parseFlags(args, new Set(['json']));
  const handle = requireFlag(flags, 'handle');
  const outputPath = flags.values.get('output') ?? null;

  return dispatchHostedCommand(
    {
      request: () =>
        postHostedJson({
          body: {
            capability: 'media-generation',
            handle,
            operation: 'status',
            operationId: `postplus-cli:media:media-generation:status:${randomUUID()}`,
          },
          pathName: '/api/postplus-cli/hosted/capability',
          skillName: null,
          context,
        }),
      errorInputLabel: 'media-poll-handle',
      json: flags.booleans.has('json'),
      outputPath,
    },
    context,
  );
}

// Resolve a media-generation endpoint by key across ALL media verbs (create /
// transcribe / …). `media estimate <endpoint-key>` addresses the endpoint
// directly (no verb positional), so it needs the endpoint's surface + fields
// without knowing which verb owns it. Returns null for an unknown key or a
// non-media-generation target (e.g. the video-analysis model).
function findMediaGenerationEndpointTarget(
  endpointKey: string,
): ResolvedVerbTarget | null {
  for (const targets of MEDIA_VERB_ENDPOINTS.values()) {
    const resolved = targets.get(endpointKey);
    if (resolved && resolved.endpoint) {
      return resolved;
    }
  }
  return null;
}

// `postplus media estimate <endpoint-key> --<same flags/--request as create>`.
// Prices a media-generation request WITHOUT reserving credit or writing the
// ledger: it builds the SAME canonical input the real submit builds (shared
// buildMediaVerbInput / resolveRequestBody + assertModelledFieldValuesInRange),
// then posts `{capability, endpointKey, input}` to the estimate boundary. The
// dry-run flags --hosted-operation-id / --quote-confirmation-token are rejected —
// they belong only to a spend submit.
async function runMediaEstimate(
  args: string[],
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
  const [endpointKey, ...rest] = args;
  if (!endpointKey || endpointKey.startsWith('--')) {
    throw new Error(
      'postplus media estimate requires an endpoint key. Run `postplus media schema --json` to list endpoints.',
    );
  }

  const resolved = findMediaGenerationEndpointTarget(endpointKey);
  if (!resolved) {
    throw new Error(
      `Unknown media estimate endpoint ${endpointKey}. Run \`postplus media schema --json\` to list media-generation endpoints.`,
    );
  }

  if (rest.some(isHelp)) {
    process.stdout.write(
      `PostPlus CLI - media estimate ${endpointKey}\n\n  Quote-only dry run (no reserve, no ledger write). Takes the same flags/--request as media create ${endpointKey}.\n  Usage:\n    postplus media estimate ${endpointKey} ${resolved.surface === 'flags' ? '--<intent/default flags>' : '--request <input.json>'} [--json] [--output <result.json>]\n`,
    );
    return 0;
  }

  const endpoint = requireResolvedEndpoint(resolved, 'estimate', endpointKey);

  const { input, json, outputPath, errorInputLabel } =
    resolved.surface === 'flags'
      ? buildEstimateFlagsInput(endpoint, endpointKey, rest)
      : await buildEstimateRequestJsonInput(endpoint, endpointKey, rest, context);

  // Same schema-driven early validation the submit path runs, so an out-of-enum
  // value fast-fails locally before the estimate call — and the estimate prices
  // exactly the request a subsequent submit would send.
  assertModelledFieldValuesInRange(endpointKey, endpoint.fields, input);

  return dispatchHostedCommand(
    {
      request: () =>
        postHostedJson({
          body: {
            capability: 'media-generation',
            endpointKey,
            input,
          },
          pathName: '/api/postplus-cli/hosted/estimate',
          skillName: resolved.skill,
          context,
        }),
      errorInputLabel,
      json,
      outputPath,
    },
    context,
  );
}

// Flags-surface input for estimate: identical flag→field mapping to the submit
// path (runMediaVerbFlags), reusing the shared buildMediaVerbInput. Rejects the
// spend-only control flags (operation id / quote-confirmation token).
function buildEstimateFlagsInput(
  endpoint: ManifestEndpoint,
  endpointKey: string,
  args: string[],
): {
  input: Record<string, unknown>;
  json: boolean;
  outputPath: string | null;
  errorInputLabel: string;
} {
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

  const flags = parseFlags(args, booleanKeys, arrayKeys);
  const controlKeys = new Set(['json', 'output', 'skill']);

  for (const key of [
    ...flags.values.keys(),
    ...flags.booleans,
    ...flags.arrays.keys(),
  ]) {
    if (!flagToField.has(key) && !controlKeys.has(key)) {
      throw new Error(`Unknown option for media estimate: --${key}.`);
    }
  }

  const input = buildMediaVerbInput({
    endpointKey,
    fields,
    flags,
    verb: 'estimate',
  });

  return {
    input,
    json: flags.booleans.has('json'),
    outputPath: flags.values.get('output') ?? null,
    errorInputLabel: `media-estimate-${endpointKey}`,
  };
}

// Request-json-surface input for estimate: reads the same nested envelope the
// submit path reads from --request, rejecting runner-managed fields.
async function buildEstimateRequestJsonInput(
  endpoint: ManifestEndpoint,
  endpointKey: string,
  args: string[],
  context: HostedRequestContext | undefined,
): Promise<{
  input: Record<string, unknown>;
  json: boolean;
  outputPath: string | null;
  errorInputLabel: string;
}> {
  const flags = parseFlags(args, new Set(['json']));
  const allowedKeys = new Set(['json', 'output', 'request', 'skill']);
  for (const key of [...flags.values.keys(), ...flags.booleans]) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option for media estimate: --${key}.`);
    }
  }

  const { body: raw, errorInputLabel } = await resolveRequestBody(
    context,
    flags,
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `media estimate ${endpointKey} --request must be a JSON object of media-generation input.`,
    );
  }
  const input = raw as Record<string, unknown>;

  for (const field of endpoint.fields) {
    if (field.class === 'runner-managed' && Object.hasOwn(input, field.name)) {
      throw new Error(
        `media estimate ${endpointKey} input must not include runner-managed field "${field.name}"; the CLI mints or derives it.`,
      );
    }
  }

  return {
    input,
    json: flags.booleans.has('json'),
    outputPath: flags.values.get('output') ?? null,
    errorInputLabel,
  };
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

    // Enum / numeric-range membership (with canonicalize-faithful casing) is gated
    // once by assertModelledFieldValuesInRange after the input is built — not here —
    // so a mixed-case "4K" is not wrongly rejected by a raw includes() check. This
    // path only parses the flag string into its typed value; the number floor below
    // keeps a non-range number field (e.g. transcription duration_seconds) positive.
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

// Manifest-driven hosted-collection verb (request-json surface). The polling path
// (`--run-handle`) resumes a pending run unchanged. The launch path resolves the
// positional `<collectionKey>` against the research verb index for verb `collect`,
// reads the collection input object directly from `--request <file>` (NOT a
// schemaVersion envelope), and posts to /hosted/collection. The resolved entry
// gives the default skillName (overridable by `--skill`); the actorId stays
// internal and is never placed on the public body.
async function runResearchCollect(
  args: string[],
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
  const [first, ...rest] = args;

  // Polling path: `research collect --run-handle <h>`. No positional collectionKey.
  if (!first || first.startsWith('--')) {
    const flags = parseFlags(args, new Set(['json']));
    const runHandle = requireFlag(flags, 'run-handle');
    const outputPath = flags.values.get('output') ?? null;

    return dispatchHostedCommand(
      {
        request: () =>
          postHostedJson({
            body: { runHandle, runHandleType: 'hosted-collection' },
            pathName: '/api/postplus-cli/hosted/collection',
            skillName: null,
            context,
          }),
        errorInputLabel: 'research-collect-run-handle',
        json: flags.booleans.has('json'),
        outputPath,
      },
      context,
    );
  }

  const verb = 'collect';
  const collectionKey = first;
  const targets = RESEARCH_VERB_TARGETS.get(verb);
  const resolved = targets?.get(collectionKey);
  if (!resolved) {
    const valid = targets ? [...targets.keys()].join(', ') : '';
    throw new Error(
      `Unknown research collect collection ${collectionKey}. Valid: ${valid}.`,
    );
  }

  // `postplus research collect <collection-key> --help`: opaque-input contract.
  if (rest.some(isHelp)) {
    printOpaqueTargetHelp('research', verb, collectionKey, resolved);
    return 0;
  }

  const flags = parseFlags(rest, new Set(['json']));
  const allowedKeys = new Set([
    'hosted-operation-id',
    'json',
    'max-charge-usd',
    'output',
    'quote-confirmation-token',
    'request',
    'skill',
  ]);
  for (const key of [...flags.values.keys(), ...flags.booleans]) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option for research ${verb}: --${key}.`);
    }
  }

  const outputPath = flags.values.get('output') ?? null;
  const { body: raw, errorInputLabel } = await resolveRequestBody(
    context,
    flags,
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `research ${verb} ${collectionKey} --request must be a JSON object of collection input.`,
    );
  }
  const input = raw as Record<string, unknown>;

  const skillName = flags.values.get('skill') ?? resolved.skill;
  const operationId =
    flags.values.get('hosted-operation-id') ??
    `postplus-cli:research:collect:${collectionKey}:${randomUUID()}`;
  const quoteConfirmationToken = flags.values.get('quote-confirmation-token');

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

  return dispatchHostedCommand(
    {
      request: () =>
        postHostedJson({
          body: {
            collectionKey,
            input,
            operationId,
            quoteConfirmationToken: quoteConfirmationToken ?? undefined,
            skillName,
            maxTotalChargeUsd,
          },
          pathName: '/api/postplus-cli/hosted/collection',
          skillName,
          context,
        }),
      errorInputLabel,
      json: flags.booleans.has('json'),
      outputPath,
    },
    context,
  );
}

// Manifest-driven public-content-collection verb (request-json surface). Resolves
// the positional `<sourceKey>` against the research verb index for verb `scrape`,
// reads the scrape input directly from `--request <file>` as a JSON ARRAY of input
// records (one per public URL/query), and posts to /hosted/capability with
// capability `public-content-collection` / operation `scrape`. The resolved entry
// gives the default skillName (overridable by `--skill`); the datasetId stays
// internal and is never placed on the public body.
async function runResearchScrape(
  args: string[],
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
  const [first, ...rest] = args;

  const verb = 'scrape';
  const targets = RESEARCH_VERB_TARGETS.get(verb);

  if (!first || first.startsWith('--')) {
    const flags = parseFlags(args, new Set(['json']));
    const runHandle = requireFlag(flags, 'run-handle');
    const outputPath = flags.values.get('output') ?? null;

    return dispatchHostedCommand(
      {
        request: () =>
          postHostedJson({
            body: { runHandle, runHandleType: 'public-content-collection' },
            pathName: '/api/postplus-cli/hosted/collection',
            skillName: null,
            context,
          }),
        errorInputLabel: 'research-scrape-run-handle',
        json: flags.booleans.has('json'),
        outputPath,
      },
      context,
    );
  }

  const sourceKey = first;
  const resolved = targets?.get(sourceKey);
  if (!resolved) {
    const valid = targets ? [...targets.keys()].join(', ') : '';
    throw new Error(
      `Unknown research scrape source ${sourceKey}. Valid: ${valid}.`,
    );
  }

  // `postplus research scrape <source-key> --help`: opaque-array-input contract.
  if (rest.some(isHelp)) {
    printOpaqueTargetHelp('research', verb, sourceKey, resolved);
    return 0;
  }

  const flags = parseFlags(rest, new Set(['json']));
  const allowedKeys = new Set([
    'hosted-operation-id',
    'json',
    'max-charge-usd',
    'output',
    'quote-confirmation-token',
    'request',
    'skill',
  ]);
  for (const key of [...flags.values.keys(), ...flags.booleans]) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option for research ${verb}: --${key}.`);
    }
  }

  const outputPath = flags.values.get('output') ?? null;
  const { body: raw, errorInputLabel } = await resolveRequestBody(
    context,
    flags,
  );
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `research ${verb} ${sourceKey} --request must be a non-empty JSON array of scrape input records.`,
    );
  }
  const input = raw as unknown[];

  const skillName = flags.values.get('skill') ?? resolved.skill;
  const operationId =
    flags.values.get('hosted-operation-id') ??
    `postplus-cli:research:scrape:${sourceKey}:${randomUUID()}`;
  const quoteConfirmationToken = flags.values.get('quote-confirmation-token');

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

  // The Web /hosted/capability scrape contract is a strict object: skillName is
  // carried as the compatibility header (postHostedJson), never on the public body.
  return dispatchHostedCommand(
    {
      request: () =>
        postHostedJson({
          body: {
            capability: 'public-content-collection',
            operation: 'scrape',
            sourceKey,
            input,
            operationId,
            quoteConfirmationToken: quoteConfirmationToken ?? undefined,
            maxTotalChargeUsd,
          },
          pathName: '/api/postplus-cli/hosted/capability',
          skillName,
          context,
        }),
      errorInputLabel,
      json: flags.booleans.has('json'),
      outputPath,
    },
    context,
  );
}

// Manifest-driven publish operation (request-json surface). The OPERATION is the
// subcommand and the target: `postplus publish <operation> --request <file>`. The
// publishing input object is read directly from `--request <file>` and posted to
// /hosted/capability with capability `social-publishing` / the resolved operation.
// Side-effecting operations surface the Web quote-confirmation challenge; the
// shared runHostedCommand handles the challenge -> retry-with-token path. There is
// no requestDimensions/approval/execute — those were private-runtime concepts.
async function runPublishOperation(
  operation: string,
  args: string[],
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
  const resolved = PUBLISH_VERB_OPERATIONS.get(operation);
  if (!resolved) {
    throw new Error(
      `Unknown publish operation ${operation}. Valid: ${[...PUBLISH_VERB_OPERATIONS.keys()].join(', ')}.`,
    );
  }

  // `postplus publish <operation> --help`: opaque-input contract.
  if (args.some(isHelp)) {
    printOpaqueTargetHelp('publish', operation, operation, resolved);
    return 0;
  }

  const flags = parseFlags(args, new Set(['json']));
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
      throw new Error(`Unknown option for publish ${operation}: --${key}.`);
    }
  }

  const outputPath = flags.values.get('output') ?? null;
  const { body: raw, errorInputLabel } = await resolveRequestBody(
    context,
    flags,
  );
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `publish ${operation} --request must be a JSON object of publishing input.`,
    );
  }
  const input = raw as Record<string, unknown>;

  const skillName = flags.values.get('skill') ?? resolved.skill;
  const operationId =
    flags.values.get('hosted-operation-id') ??
    `postplus-cli:publish:social-publishing:request:${randomUUID()}`;
  const quoteConfirmationToken = flags.values.get('quote-confirmation-token');

  return dispatchHostedCommand(
    {
      request: () =>
        postHostedJson({
          body: {
            capability: 'social-publishing',
            operation,
            input,
            operationId,
            quoteConfirmationToken: quoteConfirmationToken ?? undefined,
          },
          pathName: '/api/postplus-cli/hosted/capability',
          skillName,
          context,
        }),
      errorInputLabel,
      json: flags.booleans.has('json'),
      outputPath,
    },
    context,
  );
}

async function runHostedSchema(
  domain: HostedDomain,
  args: string[],
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
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

  const report = buildHostedRequestSchemaReport({
    collectionKey: flags.values.get('collection-key') ?? null,
    domain,
    endpointKey: flags.values.get('endpoint') ?? null,
  });

  // In-process / context path: RETURN the structured catalog so the model
  // receives it as the call result. The bin path (no context) keeps writeJson +
  // return 0 for human CLI stdout output. Mirrors the spend-verb dispatch.
  if (context) {
    return report;
  }

  writeJson(report);
  return 0;
}

async function postHostedJson(input: {
  body: unknown;
  pathName: string;
  skillName: string | null;
  // When present (the hosted-lib path) the POST uses the injected auth +
  // skillsReleaseId with NO disk read and NO 401-refresh-retry (the eve runtime
  // supplies fresh session auth each turn). When absent (the bin path) the auth
  // is resolved from disk and a single 401 triggers a forced refresh, exactly as
  // before. Either way the body/URL/headers are built identically.
  context?: HostedRequestContext;
}): Promise<unknown> {
  const response = input.context
    ? await sendAuthedCloudRequest({
        auth: input.context.auth,
        body: input.body,
        method: 'POST',
        pathName: input.pathName,
        skillName: input.skillName,
        skillsReleaseId: input.context.skillsReleaseId ?? null,
        timeoutMs: 120000,
      })
    : await sendAuthedCloudRequest({
        auth: await resolveFreshRemoteAuth(),
        body: input.body,
        method: 'POST',
        pathName: input.pathName,
        retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
        skillName: input.skillName,
        timeoutMs: 120000,
      });

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

// Single exit path for the BIN hosted command: success writes the result and
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

// Single exit path for both BIN and LIB hosted commands. Each dispatch function
// builds the SAME `request` closure (resolve verb -> build envelope -> POST) and
// hands it here. The bin path (no `context`) keeps stdout/file/exit-code behavior
// via runHostedCommand. The lib path (with `context`) returns the parsed payload
// and rethrows the structured HostedProductRequestError / quote-confirmation error
// VERBATIM — no stdout, no file writes, no exit code — so the in-process caller
// surfaces the structured JSON and fails honestly. Because the closure is shared,
// the wire request (URL + body + headers) is byte-identical across both paths.
async function dispatchHostedCommand(
  input: {
    request: () => Promise<unknown>;
    errorInputLabel: string;
    json: boolean;
    outputPath: string | null;
  },
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
  if (!context) {
    return runHostedCommand(input);
  }
  return input.request();
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
  postplus research collect <collection-key> --request <input.json> [--skill <skill-id>] [--max-charge-usd <usd>] [--output <result.json>]
  postplus research collect --run-handle <runHandle> [--output <result.json>]
  postplus research scrape <source-key> --request <input-array.json> [--skill <skill-id>] [--max-charge-usd <usd>] [--output <result.json>]
  postplus research scrape --run-handle <runHandle> [--output <result.json>]
`);
}

function printDomainVerbHelp(domain: Exclude<HostedDomain, 'research'>): void {
  const verbUsage =
    domain === 'media'
      ? [...MEDIA_VERB_ENDPOINTS.keys()]
          .map(
            (verb) =>
              `  postplus media ${verb} <endpoint-key> --<intent/default flags> [--json] [--output <result.json>]\n`,
          )
          .join('') +
        '  postplus media estimate <endpoint-key> --<same flags/--request as create> [--json]\n' +
        '  postplus media poll --handle <run-id> [--json] [--output <result.json>]\n'
      : '  postplus publish <operation> --request <input.json> [--json] [--output <result.json>]\n';

  process.stdout.write(`PostPlus CLI - ${domain} commands

Usage:
${verbUsage}  postplus ${domain} schema${domain === 'media' ? ' [--endpoint <endpoint-key>]' : ''} [--json]
`);
}

// Per-endpoint `--help` for a media-generation endpoint (and the video-analysis
// model). Renders the endpoint's field-level contract grouped into the envelope's
// three classes — intent (you write it), default (manifest-defaulted; write only
// to deviate), runner-managed (minted by the CLI; never an input) — using the
// manifest as the SSOT for flags, enum sets, ranges, and defaults.
function printMediaEndpointHelp(
  domain: 'media',
  verb: string,
  targetKey: string,
  resolved: ResolvedVerbTarget,
): void {
  // video-analysis: opaque Gemini payload, no field classification to render.
  if (resolved.capability === 'video-analysis') {
    process.stdout.write(`PostPlus CLI - ${domain} ${verb} ${targetKey}

  Surface: request-json (opaque Gemini request payload)
  Usage:
    postplus ${domain} ${verb} ${targetKey} --request <input.json> [--video-seconds <n>] [--json] [--output <result.json>]

  --request <file>  A JSON object authored verbatim as the Gemini request
                    (contents + optional generationConfig) under "payload".
  --video-seconds <n>  Optional source video duration in seconds. Supplying it
                    lets the hosted boundary route eligible short videos through
                    its preflight path; omit it to use the default route.
  Runner-managed (minted by the CLI; never in the body): operationId, quoteConfirmationToken
`);
    return;
  }

  if (!resolved.endpoint) {
    throw new Error(
      `media ${verb} ${targetKey} resolved to a non-endpoint target.`,
    );
  }

  const fields = resolved.endpoint.fields;
  const isFlagsSurface = resolved.surface === 'flags';
  const intent = fields.filter((field) => field.class === 'intent');
  const defaulted = fields.filter((field) => field.class === 'default');
  const managed = fields.filter((field) => field.class === 'runner-managed');

  const lines: string[] = [
    `PostPlus CLI - ${domain} ${verb} ${targetKey}`,
    '',
    `  Surface: ${resolved.surface}`,
    '  Usage:',
    isFlagsSurface
      ? `    postplus ${domain} ${verb} ${targetKey} ${formatFlagsUsage(fields)} [--json] [--output <result.json>]`
      : `    postplus ${domain} ${verb} ${targetKey} --request <input.json> [--json] [--output <result.json>]`,
    '',
  ];

  appendFieldGroup(
    lines,
    'Intent (you must / may write):',
    intent,
    isFlagsSurface,
  );
  appendFieldGroup(
    lines,
    'Default (manifest-defaulted; write only to deviate):',
    defaulted,
    isFlagsSurface,
  );

  if (managed.length > 0) {
    lines.push('  Runner-managed (minted by the CLI; never an input):');
    for (const field of managed) {
      const derived = field.derivedFrom
        ? ` (derived from ${field.derivedFrom})`
        : '';
      lines.push(`    ${field.name}${derived}`);
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

function formatFlagsUsage(fields: readonly ManifestField[]): string {
  const parts: string[] = [];
  for (const field of fields) {
    if (field.class === 'runner-managed' || !field.flag) {
      continue;
    }
    const token = `${field.flag} <${field.name}>`;
    parts.push(field.required ? token : `[${token}]`);
  }
  return parts.join(' ');
}

function appendFieldGroup(
  lines: string[],
  title: string,
  fields: readonly ManifestField[],
  isFlagsSurface: boolean,
): void {
  if (fields.length === 0) {
    return;
  }
  lines.push(`  ${title}`);
  for (const field of fields) {
    const label =
      isFlagsSurface && field.flag ? field.flag : `(json) ${field.name}`;
    lines.push(`    ${label}${formatFieldDetail(field)}`);
  }
  lines.push('');
}

// Field detail: type, required/optional, enum set or numeric range, default, and
// repeatable arity — all read from the manifest contract.
function formatFieldDetail(field: ManifestField): string {
  const detail: string[] = [
    field.repeatable ? `${field.type}[]` : field.type,
    field.required ? 'required' : 'optional',
  ];
  if (field.enumValues && field.enumValues.length > 0) {
    detail.push(`one of {${field.enumValues.join(', ')}}`);
  } else if (field.min !== undefined || field.max !== undefined) {
    detail.push(`range ${field.min ?? '-'}..${field.max ?? '-'}`);
  }
  if (field.default !== undefined) {
    detail.push(`default ${String(field.default)}`);
  }
  return `  [${detail.join('; ')}]`;
}

// Per-target `--help` for capabilities whose request body is an opaque JSON object
// (research collect/scrape, publish): there is no field classification to render,
// so the help states the input shape and the runner-managed protocol fields.
function printOpaqueTargetHelp(
  domain: 'research' | 'publish',
  verb: string,
  targetKey: string,
  resolved: ResolvedVerbTarget,
): void {
  const inputShape =
    resolved.capability === 'public-content-collection'
      ? 'a non-empty JSON array of provider-shaped scrape records'
      : 'a provider-shaped JSON object of input';
  // publish's operation is both the verb and the target, so the header/usage show
  // it once; research shows `<verb> <target>`.
  const header =
    domain === 'publish'
      ? `publish ${targetKey}`
      : `research ${verb} ${targetKey}`;
  const usage =
    domain === 'publish'
      ? `    postplus publish ${targetKey} --request <input.json> [--json] [--output <result.json>]`
      : `    postplus research ${verb} ${targetKey} --request <input.json> [--skill <skill-id>] [--max-charge-usd <usd>] [--json] [--output <result.json>]`;

  process.stdout.write(`PostPlus CLI - ${header}

  Surface: request-json (opaque input authored by the agent)
  Capability: ${resolved.capability}
  Usage:
${usage}

  --request <file>  ${inputShape}.
  Runner-managed (minted by the CLI; never in the body): operationId, quoteConfirmationToken
`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
