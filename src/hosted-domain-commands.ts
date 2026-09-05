import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleepMs } from 'node:timers/promises';

import { resolveFreshRemoteAuth } from './auth-session.js';
import {
  type AuthedCloudRequestAuth,
  sendAuthedCloudRequest,
} from './authed-cloud-request.js';
import { formatPostPlusCompatibilityError } from './client-compatibility.js';
import { HOSTED_MEDIA_REFERENCE_URI_PREFIX } from './generated/hosted-field-validation-core.generated.js';
import {
  assertMediaUrlFieldSchemes,
  assertModelledFieldValuesInRange,
  assertNoUnknownModelledFields,
} from './hosted-field-validation.js';
import {
  type HostedDomain,
  type ManifestEndpoint,
  type ManifestField,
  type ResolvedVerbTarget,
  buildVerbTargetIndex,
  capabilityEndpointsWithFlag,
} from './hosted-manifest-index.js';
import {
  type LocalMediaFile,
  inferMediaMimeType,
  resolveManifestMediaInputs,
} from './hosted-media-input.js';
import {
  HostedMediaDownloadError,
  type HostedMediaTransferProgress,
  type MediaFileFingerprint,
  type SignedHostedUpload,
  createMediaFileFingerprint,
  downloadHostedMediaFile,
  uploadHostedMediaFile,
} from './hosted-media-transfer.js';
import { requireHostedBaseUrl } from './hosted-release.js';
import { buildHostedRequestSchemaReport } from './hosted-request-schemas.js';
import {
  fetchWithNetworkDiagnostics,
  isNetworkFailure,
} from './network-diagnostics.js';
import {
  type LargeCreditQuoteConfirmationChallenge,
  readLargeCreditQuoteConfirmationChallenge,
} from './quote-confirmation.js';
import { clearUpdateCheckCache } from './update-check.js';

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
  // Explicit `--flag true|false` values. Presence without a value stays in
  // `booleans` (= true); an explicit value records here so a default-true
  // boolean field (e.g. seedance --generate-audio) can be switched OFF —
  // parity the retired request-json surface had via `"generate_audio": false`.
  booleanValues: Map<string, boolean>;
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
  return {
    body: await readJsonFile(requestPath),
    errorInputLabel: requestPath,
  };
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
    if (subcommand === 'run') {
      return runResearchRun(rest, context);
    }
    if (subcommand === 'collect' || subcommand === 'scrape') {
      throw new Error(
        `research ${subcommand} was removed. Migrate to \`postplus research run <route> --<semantic flags> --wait --output <result.json>\`; JSON request files and --max-charge-usd are no longer accepted.`,
      );
    }
    printResearchHelp();
    return subcommand === undefined || isHelp(subcommand) ? 0 : 1;
  }

  if (subcommand === 'schema') {
    return runHostedSchema(domain, rest, context);
  }

  // Poll a pending async media-generation run by handle. This is a hand-coded
  // branch (not a manifest verb) because a status poll has no endpointKey/field
  // contract to project — exactly like the hand-coded research resume branch.
  // It must be checked before the manifest verb dispatch.
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
  const booleanKeys = new Set<string>(['json', 'wait']);
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
    'wait',
    'wait-seconds',
    'poll-interval-seconds',
  ]);

  // Reject unknown flags. This is how runner-managed fields (no flag) and typos
  // are caught locally before any hosted call. When the flag IS declared on
  // sibling endpoints of the same capability, name them — otherwise the bare
  // rejection reads as "the CLI has no such capability" (e.g. --reference-image
  // on a text endpoint, when only edit endpoints accept it).
  for (const key of [
    ...flags.values.keys(),
    ...flags.booleans,
    ...flags.arrays.keys(),
  ]) {
    if (!flagToField.has(key) && !controlKeys.has(key)) {
      const siblings = capabilityEndpointsWithFlag(
        resolved.capability,
        `--${key}`,
      ).filter((siblingKey) => siblingKey !== endpointKey);
      throw new Error(
        siblings.length > 0
          ? `Unknown option for media ${verb}: --${key}. Endpoint ${endpointKey} does not accept it; it is supported by: ${siblings.join(', ')}.`
          : `Unknown option for media ${verb}: --${key}.`,
      );
    }
  }

  let input = buildMediaVerbInput({
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
  input = await resolveManifestMediaInputs({
    endpointKey,
    fields,
    request: input,
    stage: context
      ? null
      : ({ file, operationId }) =>
          stageHostedMediaFile({
            file,
            operationId,
            skillName: flags.values.get('skill') ?? resolved.skill,
          }),
  });
  // media-url fields fast-fail here on a local path / bare string; the Web
  // boundary enforces the same scheme set at submit time.
  assertMediaUrlFieldSchemes(endpointKey, fields, input);

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
    wait: resolveHostedSubmitWaitOption(flags),
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
  const flags = parseFlags(args.args, new Set(['json', 'wait']));
  const allowedKeys = new Set([
    'hosted-operation-id',
    'json',
    'output',
    'quote-confirmation-token',
    'request',
    'skill',
    'wait',
    'wait-seconds',
    'poll-interval-seconds',
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
  let input = raw as Record<string, unknown>;

  assertNoUnknownModelledFields(endpointKey, endpoint.fields, input);

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
  input = await resolveManifestMediaInputs({
    endpointKey,
    fields: endpoint.fields,
    request: input,
    stage: context
      ? null
      : ({ file, operationId }) =>
          stageHostedMediaFile({
            file,
            operationId,
            skillName: flags.values.get('skill') ?? resolved.skill,
          }),
  });
  // media-url fields fast-fail here on a local path / bare string; the Web
  // boundary enforces the same scheme set at submit time.
  assertMediaUrlFieldSchemes(endpointKey, endpoint.fields, input);

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
    wait: resolveHostedSubmitWaitOption(flags),
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

// video-analysis verb (normalized flags surface). The agent supplies only the
// video role and analysis prompt; local media is durably staged by the same
// Manifest-driven transport as generation. Provider payload construction is a
// Web concern and never appears in CLI or Skill input.
async function runVideoAnalysisVerb(args: {
  args: string[];
  modelKey: string;
  resolved: ResolvedVerbTarget;
  verb: string;
  context: HostedRequestContext | undefined;
}): Promise<number | unknown> {
  const { modelKey, resolved, verb, context } = args;
  const model = resolved.model;
  if (!model) {
    throw new Error(
      `media ${verb} ${modelKey} resolved without a model contract.`,
    );
  }
  const flags = parseFlags(args.args, new Set(['json']));
  const allowedKeys = new Set([
    'hosted-operation-id',
    'json',
    'output',
    'quote-confirmation-token',
    'prompt',
    'skill',
    'video-seconds',
    'video',
  ]);
  for (const key of [...flags.values.keys(), ...flags.booleans]) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option for media ${verb}: --${key}.`);
    }
  }

  const outputPath = flags.values.get('output') ?? null;
  const prompt = requireFlag(flags, 'prompt');
  let normalizedInput: Record<string, unknown> = {
    prompt,
    video: requireFlag(flags, 'video'),
  };
  normalizedInput = await resolveManifestMediaInputs({
    endpointKey: modelKey,
    fields: model.fields,
    request: normalizedInput,
    stage: context
      ? null
      : ({ file, operationId }) =>
          stageHostedMediaFile({
            file,
            operationId,
            skillName: flags.values.get('skill') ?? resolved.skill,
          }),
  });
  assertMediaUrlFieldSchemes(modelKey, model.fields, normalizedInput);

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
    input: normalizedInput,
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
      errorInputLabel: `media-${verb}-${modelKey}`,
      json: flags.booleans.has('json'),
      outputPath,
    },
    context,
  );
}

// `media-file upload`: an advanced durable pre-staging verb. Normal media
// commands accept local paths directly; this command exists only when a caller
// intentionally wants a reusable PostPlus media identity. It never chooses or
// calls a provider transport.
function inferUploadMimeType(filePath: string): string {
  return inferMediaMimeType(filePath) ?? 'application/octet-stream';
}

export async function runMediaFileCommand(
  args: string[],
  context?: HostedRequestContext,
): Promise<number | unknown> {
  const [subcommand, ...rest] = args;
  // `postplus media-file <upload|download> --help|-h|help`: the subcommand
  // parsers register only their own boolean flags (upload: `json`; download:
  // `debug`, `json`), so a `--help` sitting in `rest` is treated as an unknown
  // value-taking flag by parseFlags and throws `Missing value for --help.`.
  // Intercept subcommand-level help here — before dispatch — and render the
  // shared media-file help, matching how every other hosted command handles
  // `rest.some(isHelp)`. Not gated on rest.length so `upload --input-file x
  // --help` still shows help rather than erroring.
  if (
    (subcommand === 'upload' || subcommand === 'download') &&
    rest.some(isHelp)
  ) {
    printMediaFileHelp();
    return 0;
  }
  if (subcommand === 'upload') {
    return runMediaFileUpload(rest, context);
  }
  if (subcommand === 'download') {
    return runMediaFileDownload(rest, context);
  }
  printMediaFileHelp();
  return subcommand === undefined || isHelp(subcommand) ? 0 : 1;
}

/**
 * In-process capability envelope POST (hosted-lib path). A trusted host runtime
 * (eve-agent) posts a raw `/hosted/capability` body — e.g. the `workflow` verb
 * family — through the SAME transport core the bin verbs use (`postHostedJson`:
 * canonical headers, structured HostedProductRequestError, quote-confirmation
 * error thrown verbatim). The bin counterpart to the same `workflow` verbs is
 * `postplus workflow` (runWorkflowCommand, disk session auth); this entry is for
 * a host that already holds session auth and builds the envelope itself.
 * Requires the injected context auth; there is intentionally no disk-config
 * fallback on this entry.
 */
export async function postHostedCapabilityEnvelope(input: {
  body: Record<string, unknown>;
  context: HostedRequestContext;
}): Promise<unknown> {
  return postHostedJson({
    body: input.body,
    context: input.context,
    pathName: '/api/postplus-cli/hosted/capability',
    skillName: null,
  });
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
  const fingerprint = await createMediaFileFingerprint(absolutePath);
  const outputPath = flags.values.get('output') ?? null;
  const hostedOperationId = flags.values.get('hosted-operation-id') ?? null;

  const body = {
    capability: 'media-file',
    operation: 'create-upload-url',
    file: {
      fingerprint,
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
        const mediaReference = readMediaReferenceValue(output);
        await uploadHostedMediaFile({
          absolutePath,
          fingerprint,
          operationId: body.operationId,
          options: { onProgress: createTransferProgressReporter() },
          signedUpload,
        });

        return buildDurableUploadResult(payload, mediaReference);
      },
      errorInputLabel: inputFile,
      json: flags.booleans.has('json'),
      outputPath,
    },
    context,
  );
}

/**
 * `media-file download`: fetch produced/uploaded media bytes to a local file.
 * `--reference <postplus-media://...>` exchanges the persistent reference for a
 * fresh signed read URL via the uncharged hosted `create-read-url` operation
 * (works long after the original signed URL expired); `--url <https://...>`
 * fetches a still-fresh provider or signed URL directly. Exactly one source is
 * required. Note: for most provider families the historical `runs show`
 * providerUrls are provider-side temporary URLs — download while fresh, or
 * upload-derived media via `--reference`.
 */
async function runMediaFileDownload(
  args: string[],
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
  const flags = parseFlags(args, new Set(['debug', 'json', 'restart']));
  const allowedKeys = new Set([
    'hosted-operation-id',
    'debug',
    'json',
    'output',
    'output-file',
    'reference',
    'restart',
    'skill',
    'url',
  ]);
  for (const key of [...flags.values.keys(), ...flags.booleans]) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown option for media-file download: --${key}.`);
    }
  }

  const reference = flags.values.get('reference') ?? null;
  const directUrl = flags.values.get('url') ?? null;
  if ((reference === null) === (directUrl === null)) {
    throw new Error(
      'media-file download requires exactly one of --reference <postplus-media://...> or --url <https://...>.',
    );
  }
  if (
    reference !== null &&
    !reference.startsWith(HOSTED_MEDIA_REFERENCE_URI_PREFIX)
  ) {
    throw new Error(
      `media-file download --reference must start with ${HOSTED_MEDIA_REFERENCE_URI_PREFIX}.`,
    );
  }
  if (directUrl !== null && !/^https:\/\//iu.test(directUrl)) {
    throw new Error('media-file download --url must be a remote HTTPS URL.');
  }
  const outputFile = requireFlag(flags, 'output-file');
  const absoluteOutput = path.resolve(outputFile);
  const outputPath = flags.values.get('output') ?? null;
  const hostedOperationId = flags.values.get('hosted-operation-id') ?? null;
  const debug = flags.booleans.has('debug');
  const restart = flags.booleans.has('restart');
  const downloadOperationId =
    hostedOperationId ??
    `postplus-cli:media-file:download:${createHash('sha256')
      .update(`${reference ?? directUrl}\n${absoluteOutput}`)
      .digest('hex')}`;
  const checkpointId = createHash('sha256')
    .update(`${downloadOperationId}\n${absoluteOutput}`)
    .digest('hex');

  return dispatchHostedCommand(
    {
      request: async () => {
        let downloadUrl = directUrl;
        if (reference !== null) {
          const cloudBaseUrl =
            context?.auth.apiBaseUrl ?? (await requireHostedBaseUrl());
          let payload: unknown;

          try {
            payload = await postHostedJson({
              body: {
                capability: 'media-file',
                operation: 'create-read-url',
                file: { mediaReference: reference },
                operationId: `postplus-cli:media-file:create-read-url:${downloadOperationId}`,
              },
              pathName: '/api/postplus-cli/hosted/capability',
              skillName: flags.values.get('skill') ?? null,
              context,
              debug,
            });
          } catch (error) {
            if (!isNetworkFailure(error)) {
              throw error;
            }

            throw new HostedMediaDownloadError({
              cause: error,
              checkpointId,
              code: 'source_rejected',
              resumeAvailable: false,
              retryable: true,
              stage: 'resolve-read-url',
              targetUrl: cloudBaseUrl,
              totalBytes: null,
              transferredBytes: 0,
              userAction: 'Retry the same command to resolve a fresh read URL.',
            });
          }

          const output = readHostedUploadOutput(payload);
          const signedUrl = output.signedUrl;
          if (typeof signedUrl !== 'string' || !signedUrl.trim()) {
            throw new Error(
              'Hosted media create-read-url response is missing signedUrl.',
            );
          }
          downloadUrl = signedUrl.trim();
        }
        const sizeBytes = await downloadHostedMediaFile({
          absoluteOutput,
          debug,
          operationId: downloadOperationId,
          options: { onProgress: createTransferProgressReporter() },
          request: (url, init) =>
            fetchWithNetworkDiagnostics(url, init, {
              debug,
              label: 'media-download',
              redirectPolicy: 'follow-https',
            }),
          restart,
          url: downloadUrl as string,
        });
        return {
          output: {
            downloadedTo: absoluteOutput,
            sizeBytes,
            source: reference ? 'postplus-media-reference' : 'https-url',
          },
        };
      },
      errorInputLabel: reference ?? (directUrl as string),
      json: flags.booleans.has('json'),
      outputPath,
    },
    context,
  );
}

function readHostedUploadOutput(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const output = (payload as Record<string, unknown>).output;
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      return output as Record<string, unknown>;
    }
  }
  throw new Error('Hosted media upload response is missing output.');
}

function readSignedUpload(output: Record<string, unknown>): SignedHostedUpload {
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
  if (record.method !== 'PUT' && record.method !== 'TUS') {
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
  if (record.method === 'PUT') {
    return { method: 'PUT', requiredHeaders, url: record.url.trim() };
  }
  const chunkSizeBytes = Number(record.chunkSizeBytes);
  const expiresInSeconds = Number(record.expiresInSeconds);
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new Error(
      'Hosted media TUS signed upload chunkSizeBytes must be a positive integer.',
    );
  }
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error(
      'Hosted media TUS signed upload expiresInSeconds must be a positive integer.',
    );
  }
  const metadata: Record<string, string> = {};
  if (
    record.metadata &&
    typeof record.metadata === 'object' &&
    !Array.isArray(record.metadata)
  ) {
    for (const [key, value] of Object.entries(
      record.metadata as Record<string, unknown>,
    )) {
      if (typeof value !== 'string') {
        throw new Error(
          `Hosted media TUS signed upload metadata.${key} must be a string.`,
        );
      }
      metadata[key] = value;
    }
  }
  return {
    chunkSizeBytes,
    expiresInSeconds,
    metadata,
    method: 'TUS',
    requiredHeaders,
    url: record.url.trim(),
  };
}

function readMediaReferenceValue(output: Record<string, unknown>): string {
  const mediaReference = output.mediaReference;
  if (
    typeof mediaReference !== 'string' ||
    !mediaReference.startsWith(HOSTED_MEDIA_REFERENCE_URI_PREFIX)
  ) {
    throw new Error(
      `Hosted media upload response is missing the persistent ${HOSTED_MEDIA_REFERENCE_URI_PREFIX} mediaReference.`,
    );
  }
  return mediaReference;
}

// Internal transport for a Manifest-declared local media input. It intentionally
// stops at the durable PostPlus reference: endpoint-owned provider
// materialization happens later at the Web boundary, after every local file has
// staged successfully and before the single provider submit.
async function stageHostedMediaFile(input: {
  file: LocalMediaFile;
  operationId: string;
  skillName: string;
}): Promise<string> {
  const payload = await postHostedJson({
    body: {
      capability: 'media-file',
      operation: 'create-upload-url',
      file: {
        fingerprint: toMediaFileFingerprint(input.file),
        mimeType: input.file.mimeType,
        name: input.file.name,
        sizeBytes: input.file.sizeBytes,
      },
      operationId: input.operationId,
    },
    pathName: '/api/postplus-cli/hosted/capability',
    skillName: input.skillName,
  });
  const output = readHostedUploadOutput(payload);
  await uploadHostedMediaFile({
    absolutePath: input.file.absolutePath,
    fingerprint: toMediaFileFingerprint(input.file),
    operationId: input.operationId,
    options: { onProgress: createTransferProgressReporter() },
    signedUpload: readSignedUpload(output),
  });
  return readMediaReferenceValue(output);
}

function buildDurableUploadResult(
  payload: unknown,
  mediaReference: string,
): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(
      'Hosted media create-upload-url response is invalid; cannot return the storage handoff.',
    );
  }
  return {
    ...(payload as Record<string, unknown>),
    output: {
      mediaReference,
    },
  };
}

function toMediaFileFingerprint(file: LocalMediaFile): MediaFileFingerprint {
  return {
    contentSha256: file.contentSha256,
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes,
  };
}

function createTransferProgressReporter() {
  let lastReportedAt = 0;
  let lastReportedBytes = -1;
  return (progress: HostedMediaTransferProgress) => {
    const now = Date.now();
    const isTerminal =
      progress.totalBytes !== null &&
      progress.transferredBytes >= progress.totalBytes;
    if (
      !progress.userAction &&
      !isTerminal &&
      now - lastReportedAt < 1_000 &&
      progress.transferredBytes - lastReportedBytes < 1024 * 1024
    ) {
      return;
    }
    const suffix = progress.userAction ? `; ${progress.userAction}` : '';
    process.stderr.write(
      `PostPlus media transfer: stage=${progress.stage} bytes=${progress.transferredBytes}/${progress.totalBytes ?? 'unknown'} attempt=${progress.attempt}${suffix}\n`,
    );
    lastReportedAt = now;
    lastReportedBytes = progress.transferredBytes;
  };
}

function printMediaFileHelp(): void {
  process.stdout.write(`PostPlus CLI - media-file commands

Most media commands accept local paths directly through role flags such as
--reference-image, --reference-video, --audio, or --video. Use media-file only
when you intentionally want to pre-stage one file for reuse or download a
completed artifact.

Usage:
  postplus media-file upload --input-file <path> [--mime <type>] [--skill <skill-id>] [--json] [--output <result.json>]
  postplus media-file download (--reference <postplus-media://...> | --url <https://...>) --output-file <path> [--restart] [--skill <skill-id>] [--debug] [--json] [--output <result.json>]

Upload returns a reusable PostPlus media reference. Normal generation commands
prepare local role files automatically.
`);
}

// Shared submit path for both surfaces: wrap the media input, derive billing
// dimensions from endpointKey + input, and POST to the Web boundary.
// A legal high-cardinality request may spend up to the Web route's 800s ceiling
// registering media, waiting for Active, and accepting the one generation submit.
// Keep the client slightly wider so it never abandons a request the server can still
// submit and bill.
const HOSTED_MEDIA_CREATE_REQUEST_TIMEOUT_MS = 14 * 60_000;

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
  wait: { pollIntervalMs: number; waitBudgetMs: number } | null;
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
      request: async () => {
        const submitted = await postHostedJson({
          body,
          pathName: '/api/postplus-cli/hosted/capability',
          skillName: params.skillName,
          context: params.context,
          timeoutMs: HOSTED_MEDIA_CREATE_REQUEST_TIMEOUT_MS,
        });
        if (!params.wait) {
          return submitted;
        }
        const run = readMediaPollRun(submitted);
        if (!run.status || isTerminalRunStatus(run.status)) {
          return submitted;
        }
        if (!run.id) {
          throw new Error(
            `Media submit returned non-terminal status ${run.status} without a resumable run handle.`,
          );
        }
        return pollHostedRunUntilSettled({
          pollIntervalMs: params.wait.pollIntervalMs,
          pollOnce: () =>
            postHostedJson({
              body: {
                capability: 'media-generation',
                handle: run.id,
                operation: 'status',
                operationId: `postplus-cli:media:media-generation:status:${randomUUID()}`,
              },
              pathName: '/api/postplus-cli/hosted/capability',
              skillName: null,
              context: params.context,
            }),
          readStatus: (payload) => readMediaPollRun(payload).status,
          waitBudgetMs: params.wait.waitBudgetMs,
        });
      },
      errorInputLabel: params.errorInputLabel,
      json: params.json,
      outputPath: params.outputPath,
      asyncResume: (payload) =>
        extractMediaPollResume(payload, params.outputPath),
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
// internal handle-based half of the research resume branch.
//
// Bounded wait: video/audio renders take minutes, and an agent caller has no
// sleep primitive of its own — a single-shot poll forced it to hammer this verb
// in a tight model loop (production thread 1d744908, 2026-07-16: ~35 polls at
// ~6s apart for one 3.5-minute render, each with a narrated "still processing"
// line). So one invocation now waits INSIDE the command: it re-checks the
// status boundary every --poll-interval-seconds (default 8) until the run is
// terminal or the --wait-seconds budget (default 45, max 600) is spent, then
// returns the latest payload either way. Each check is the same short read-only
// HTTP request — nothing holds a connection open, and a payload without a
// readable run status returns immediately rather than looping blind.
// `--wait-seconds 0` restores the legacy single status check.
const HOSTED_RUN_DEFAULT_WAIT_SECONDS = 45;
const HOSTED_SUBMIT_DEFAULT_WAIT_SECONDS = 600;
const HOSTED_RUN_MAX_WAIT_SECONDS = 600;
const HOSTED_RUN_DEFAULT_INTERVAL_SECONDS = 8;
const HOSTED_RUN_MAX_INTERVAL_SECONDS = 60;

async function runMediaPoll(
  args: string[],
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
  const flags = parseFlags(args, new Set(['debug', 'json']));
  const handle = requireFlag(flags, 'handle');
  const outputPath = flags.values.get('output') ?? null;
  const { pollIntervalMs, waitBudgetMs } = resolveHostedRunWaitFlags(flags);

  const pollOnce = () =>
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
      debug: flags.booleans.has('debug'),
    });

  return dispatchHostedCommand(
    {
      request: () =>
        pollHostedRunUntilSettled({
          pollIntervalMs,
          pollOnce,
          readStatus: (payload) => readMediaPollRun(payload).status,
          waitBudgetMs,
        }),
      errorInputLabel: 'media-poll-handle',
      json: flags.booleans.has('json'),
      outputPath,
    },
    context,
  );
}

// Shared bounded wait loop for every resumable hosted run (`media poll
// --handle`, `research collect/scrape --run-handle`). One invocation re-checks
// the read-only status boundary until the run is terminal, the payload stops
// exposing a readable status (fail safe: return it rather than loop blind), or
// the wait budget is spent — then returns the latest payload as-is. Every check
// is an independent short HTTP read; nothing holds a connection open.
async function pollHostedRunUntilSettled(input: {
  pollIntervalMs: number;
  pollOnce: () => Promise<unknown>;
  readStatus: (payload: unknown) => string | null;
  waitBudgetMs: number;
}): Promise<unknown> {
  const startedAt = Date.now();
  while (true) {
    const payload = await input.pollOnce();
    const status = input.readStatus(payload);
    if (!status || isTerminalRunStatus(status)) {
      return payload;
    }
    const remainingMs = input.waitBudgetMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return payload;
    }
    await sleepMs(Math.min(input.pollIntervalMs, remainingMs));
  }
}

type ResearchVerb = 'run';

type ResearchRunProjection = {
  routeKey: string | null;
  runHandle: string | null;
  status: string | null;
};

function readResearchRunRecord(value: unknown): ResearchRunProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { routeKey: null, runHandle: null, status: null };
  }
  const record = value as Record<string, unknown>;
  return {
    routeKey:
      typeof record.routeKey === 'string' && record.routeKey.trim()
        ? record.routeKey
        : null,
    // Validate non-blank but return the original bytes. A signed opaque handle
    // must never be normalized, trimmed, or reconstructed by this boundary.
    runHandle:
      typeof record.runHandle === 'string' && record.runHandle.trim()
        ? record.runHandle
        : null,
    status:
      typeof record.status === 'string' && record.status.trim()
        ? record.status
        : null,
  };
}

// The hosted-collection route projects runHandle/status at the top level,
// while the generic hosted-capability route projects public-content collection
// state under `output`. Research owns that transport difference here so every
// resume caller consumes one stable projection.
function readResearchRun(payload: unknown): ResearchRunProjection {
  const topLevel = readResearchRunRecord(payload);
  if (topLevel.runHandle || topLevel.status) {
    return topLevel;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return topLevel;
  }
  return readResearchRunRecord((payload as Record<string, unknown>).output);
}

function readResearchRunStatus(payload: unknown): string | null {
  return readResearchRun(payload).status;
}

function assertResearchResumePayload(
  payload: unknown,
  verb: ResearchVerb,
): void {
  const { runHandle, status } = readResearchRun(payload);
  if (status) {
    if (!isTerminalRunStatus(status) && !runHandle) {
      throw new Error(
        `Research ${verb} returned non-terminal status without a resumable run handle.`,
      );
    }
    return;
  }

  throw new Error(
    `Research ${verb} returned an unrecognized resume response without status.`,
  );
}

async function resolveResearchResumeInput(input: {
  context: HostedRequestContext | undefined;
  flags: ParsedFlags;
  verb: ResearchVerb;
  routeKey?: string | null;
}): Promise<{
  outputPath: string | null;
  preserveCheckpointOnError: boolean;
  routeKey: string;
  runHandle: string;
}> {
  const allowedKeys = new Set([
    'json',
    'output',
    'poll-interval-seconds',
    'resume-from',
    'run-handle',
    'wait-seconds',
  ]);
  for (const key of [...input.flags.values.keys(), ...input.flags.booleans]) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `Unknown option for research ${input.verb} resume: --${key}.`,
      );
    }
  }

  const directRunHandle = input.flags.values.get('run-handle') ?? null;
  const resumeFrom = input.flags.values.get('resume-from') ?? null;

  if (input.context) {
    if (resumeFrom) {
      throw new Error(
        `research ${input.verb} --resume-from is only available in the local CLI; the hosted runtime must pass its structured run handle.`,
      );
    }
    if (!input.routeKey) {
      throw new Error(
        'research run resume requires the route key before --run-handle.',
      );
    }
    return {
      outputPath: input.flags.values.get('output') ?? null,
      preserveCheckpointOnError: false,
      routeKey: input.routeKey,
      runHandle: requireFlag(input.flags, 'run-handle'),
    };
  }

  if (directRunHandle) {
    throw new Error(
      `Direct --run-handle is not accepted by the local CLI. Use research ${input.verb} --resume-from <result.json>.`,
    );
  }
  if (input.flags.values.has('output')) {
    throw new Error(
      `research ${input.verb} --resume-from updates its checkpoint file directly; do not also pass --output.`,
    );
  }

  const checkpointPath = path.resolve(requireFlag(input.flags, 'resume-from'));
  const checkpoint = await readJsonFile(checkpointPath);
  const { routeKey, runHandle, status } = readResearchRun(checkpoint);
  if (status && isTerminalRunStatus(status)) {
    throw new Error(
      `Research ${input.verb} checkpoint is already terminal (${status}).`,
    );
  }
  if (!runHandle) {
    throw new Error(
      `Research ${input.verb} checkpoint contains no resumable run handle: ${checkpointPath}`,
    );
  }
  if (!routeKey) {
    throw new Error(
      `Research ${input.verb} checkpoint contains no route key: ${checkpointPath}`,
    );
  }

  return {
    outputPath: checkpointPath,
    preserveCheckpointOnError: true,
    routeKey,
    runHandle,
  };
}

// Parse the shared `--wait-seconds` / `--poll-interval-seconds` pair used by
// every resumable hosted run verb.
function resolveHostedRunWaitFlags(flags: ParsedFlags): {
  pollIntervalMs: number;
  waitBudgetMs: number;
} {
  return {
    pollIntervalMs: resolvePositiveSecondsFlag(flags, 'poll-interval-seconds', {
      allowZero: false,
      defaultSeconds: HOSTED_RUN_DEFAULT_INTERVAL_SECONDS,
      maxSeconds: HOSTED_RUN_MAX_INTERVAL_SECONDS,
    }),
    waitBudgetMs: resolvePositiveSecondsFlag(flags, 'wait-seconds', {
      allowZero: true,
      defaultSeconds: HOSTED_RUN_DEFAULT_WAIT_SECONDS,
      maxSeconds: HOSTED_RUN_MAX_WAIT_SECONDS,
    }),
  };
}

function resolveHostedSubmitWaitFlags(flags: ParsedFlags): {
  pollIntervalMs: number;
  waitBudgetMs: number;
} {
  return {
    pollIntervalMs: resolvePositiveSecondsFlag(flags, 'poll-interval-seconds', {
      allowZero: false,
      defaultSeconds: HOSTED_RUN_DEFAULT_INTERVAL_SECONDS,
      maxSeconds: HOSTED_RUN_MAX_INTERVAL_SECONDS,
    }),
    waitBudgetMs: resolvePositiveSecondsFlag(flags, 'wait-seconds', {
      allowZero: true,
      defaultSeconds: HOSTED_SUBMIT_DEFAULT_WAIT_SECONDS,
      maxSeconds: HOSTED_RUN_MAX_WAIT_SECONDS,
    }),
  };
}

function resolveHostedSubmitWaitOption(
  flags: ParsedFlags,
): { pollIntervalMs: number; waitBudgetMs: number } | null {
  const wait = flags.booleans.has('wait');
  if (
    !wait &&
    (flags.values.has('wait-seconds') ||
      flags.values.has('poll-interval-seconds'))
  ) {
    throw new Error(
      '--wait-seconds and --poll-interval-seconds require --wait on a media submit.',
    );
  }
  return wait ? resolveHostedSubmitWaitFlags(flags) : null;
}

// Parse a `--<key> <seconds>` duration flag (decimals allowed) into
// milliseconds, fail-fast on anything outside its domain.
function resolvePositiveSecondsFlag(
  flags: ParsedFlags,
  key: string,
  domain: { allowZero: boolean; defaultSeconds: number; maxSeconds: number },
): number {
  const raw = flags.values.get(key);
  if (raw === undefined) {
    return domain.defaultSeconds * 1000;
  }
  const seconds = Number(raw);
  const minimum = domain.allowZero ? 0 : Number.MIN_VALUE;
  const milliseconds = Math.round(seconds * 1000);
  if (
    !Number.isFinite(seconds) ||
    seconds < minimum ||
    seconds > domain.maxSeconds ||
    // Sub-millisecond positive values (e.g. 0.0004) round to 0ms and would
    // escape the exclusive-zero domain (0ms poll interval = unthrottled loop).
    (!domain.allowZero && milliseconds === 0)
  ) {
    throw new Error(
      `--${key} must be a number between ${domain.allowZero ? 0 : '0 (exclusive)'} and ${domain.maxSeconds}.`,
    );
  }
  return milliseconds;
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
      `PostPlus CLI - media estimate ${endpointKey}\n\n  Read-only PostPlus credit estimate. Takes the same public inputs as the matching media submit command for ${endpointKey}.\n  Usage:\n    postplus media estimate ${endpointKey} ${resolved.surface === 'flags' ? '--<role-or-intent flags>' : '--request <input.json>'} [--json] [--output <result.json>]\n`,
    );
    return 0;
  }

  const endpoint = requireResolvedEndpoint(resolved, 'estimate', endpointKey);

  const built =
    resolved.surface === 'flags'
      ? buildEstimateFlagsInput(endpoint, endpointKey, rest)
      : await buildEstimateRequestJsonInput(
          endpoint,
          endpointKey,
          rest,
          context,
        );
  let input = built.input;

  // Same schema-driven early validation the submit path runs, so an out-of-enum
  // value fast-fails locally before the estimate call — and the estimate prices
  // exactly the request a subsequent submit would send.
  assertModelledFieldValuesInRange(endpointKey, endpoint.fields, input);
  // An exact quote uses the same canonical media request as submit. Local files
  // are durably staged here (uncharged and cacheable), so the later approved
  // submit reuses the same reference instead of introducing a second input path.
  input = await resolveManifestMediaInputs({
    endpointKey,
    fields: endpoint.fields,
    request: input,
    stage: context
      ? null
      : ({ file, operationId }) =>
          stageHostedMediaFile({
            file,
            operationId,
            skillName: built.skillName ?? resolved.skill,
          }),
  });
  assertMediaUrlFieldSchemes(endpointKey, endpoint.fields, input);

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
          skillName: built.skillName ?? resolved.skill,
          context,
        }),
      errorInputLabel: built.errorInputLabel,
      json: built.json,
      outputPath: built.outputPath,
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
  skillName: string | undefined;
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
    skillName: flags.values.get('skill'),
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
  skillName: string | undefined;
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
    skillName: flags.values.get('skill'),
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
      const explicit = input.flags.booleanValues.get(key);
      if (explicit !== undefined) {
        record[field.name] = explicit;
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
      const modelledNonPositive =
        field.enumValues?.includes(String(parsed)) === true ||
        field.specialValues?.includes(parsed) === true;
      if (!Number.isFinite(parsed) || (parsed <= 0 && !modelledNonPositive)) {
        throw new Error(`--${key} must be a positive number.`);
      }
      record[field.name] = parsed;
    } else {
      record[field.name] = raw;
    }
  }

  return record;
}

// Manifest-driven semantic Research surface. The route contract supplies every
// accepted flag and default; the CLI sends only canonical product intent. The Web
// privately compiles that intent to the execution request.
async function runResearchRun(
  args: string[],
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
  const [first, ...rest] = args;
  const verb = 'run';
  const targets = RESEARCH_VERB_TARGETS.get(verb);
  const hasRoute = Boolean(first && !first.startsWith('--'));
  const routeKey = hasRoute ? first : null;
  const resumeArgs = hasRoute ? rest : args;
  const isResume = resumeArgs.some(
    (arg) => arg === '--resume-from' || arg === '--run-handle',
  );

  if (!hasRoute || isResume) {
    const flags = parseFlags(resumeArgs, new Set(['json']));
    const {
      outputPath,
      preserveCheckpointOnError,
      routeKey: resumeRouteKey,
      runHandle,
    } = await resolveResearchResumeInput({
      context,
      flags,
      verb,
      routeKey,
    });
    assertKnownResearchRoute(targets, resumeRouteKey);
    const { pollIntervalMs, waitBudgetMs } = resolveHostedRunWaitFlags(flags);

    return dispatchHostedCommand(
      {
        request: () =>
          pollHostedRunUntilSettled({
            pollIntervalMs,
            pollOnce: async () => {
              const payload = await postHostedJson({
                body: { routeKey: resumeRouteKey, runHandle },
                pathName: '/api/postplus-cli/hosted/research',
                skillName: null,
                context,
              });
              assertResearchResumePayload(payload, verb);
              return payload;
            },
            readStatus: readResearchRunStatus,
            waitBudgetMs,
          }),
        errorInputLabel: 'research-run-handle',
        json: flags.booleans.has('json'),
        outputPath,
        preserveOutputOnProductError: preserveCheckpointOnError,
      },
      context,
    );
  }

  const resolved = targets?.get(routeKey!);
  if (!resolved) {
    const valid = targets ? [...targets.keys()].join(', ') : '';
    throw new Error(`Unknown research route ${routeKey}. Valid: ${valid}.`);
  }

  if (rest.some(isHelp)) {
    printResearchRouteHelp(routeKey!, resolved);
    return 0;
  }

  const contract = readResolvedResearchContract(routeKey!, resolved);
  const flagToField = new Map<string, ManifestField>();
  const booleanKeys = new Set<string>(['json', 'wait']);
  const arrayKeys = new Set<string>();
  for (const field of contract.fields) {
    const key = field.flag!.replace(/^--/u, '');
    flagToField.set(key, field);
    if (field.type === 'boolean') {
      booleanKeys.add(key);
    }
    if (field.repeatable) {
      arrayKeys.add(key);
    }
  }

  const flags = parseFlags(rest, booleanKeys, arrayKeys);
  const controlKeys = new Set([
    'hosted-operation-id',
    'json',
    'output',
    'poll-interval-seconds',
    'quote-confirmation-token',
    'skill',
    'wait',
    'wait-seconds',
  ]);
  for (const key of [
    ...flags.values.keys(),
    ...flags.booleans,
    ...flags.arrays.keys(),
  ]) {
    if (!flagToField.has(key) && !controlKeys.has(key)) {
      throw new Error(`Unknown option for research run: --${key}.`);
    }
  }

  const outputPath = flags.values.get('output') ?? null;
  if (!context && !outputPath) {
    throw new Error(
      'Local research run requires --output <result.json> so an asynchronous run has a durable checkpoint.',
    );
  }
  const input = buildResearchIntent(routeKey!, contract, flags);
  const skillName = flags.values.get('skill') ?? resolved.skill;
  const operationId =
    flags.values.get('hosted-operation-id') ??
    `postplus-cli:research:run:${routeKey}:${randomUUID()}`;
  const quoteConfirmationToken = flags.values.get('quote-confirmation-token');
  const wait = resolveHostedSubmitWaitOption(flags);
  let checkpointWritten = false;

  return dispatchHostedCommand(
    {
      request: async () => {
        const submitted = await postHostedJson({
          body: {
            routeKey,
            input,
            operationId,
            quoteConfirmationToken: quoteConfirmationToken ?? undefined,
          },
          pathName: '/api/postplus-cli/hosted/research',
          skillName,
          context,
        });
        assertResearchResumePayload(submitted, verb);
        if (!wait) {
          return submitted;
        }
        const run = readResearchRun(submitted);
        if (!run.status || isTerminalRunStatus(run.status)) {
          return submitted;
        }
        if (!run.runHandle) {
          throw new Error(
            `Research run returned non-terminal status ${run.status} without a resumable run handle.`,
          );
        }
        if (!context && outputPath) {
          await writeResult(submitted, outputPath, false);
          checkpointWritten = true;
        }
        return pollHostedRunUntilSettled({
          pollIntervalMs: wait.pollIntervalMs,
          pollOnce: () =>
            postHostedJson({
              body: { routeKey, runHandle: run.runHandle },
              pathName: '/api/postplus-cli/hosted/research',
              skillName: null,
              context,
            }),
          readStatus: readResearchRunStatus,
          waitBudgetMs: wait.waitBudgetMs,
        });
      },
      errorInputLabel: `research-run-${routeKey}`,
      json: flags.booleans.has('json'),
      outputPath,
      preserveOutputOnProductError: () => checkpointWritten,
      preservedOutputRecovery: () =>
        checkpointWritten && outputPath
          ? [
              'Research run was submitted, but status polling failed.',
              `Checkpoint preserved at ${path.resolve(outputPath)}.`,
              `Resume: postplus research ${verb} --resume-from ${shellQuoteArg(
                path.resolve(outputPath),
              )}`,
            ].join(' ')
          : null,
      asyncResume: (payload) =>
        extractResearchResume(payload, verb, outputPath),
    },
    context,
  );
}

function assertKnownResearchRoute(
  targets: Map<string, ResolvedVerbTarget> | undefined,
  routeKey: string,
): void {
  if (!targets?.has(routeKey)) {
    throw new Error(
      `Unknown research route ${routeKey}. Valid: ${targets ? [...targets.keys()].join(', ') : ''}.`,
    );
  }
}

function readResolvedResearchContract(
  routeKey: string,
  resolved: ResolvedVerbTarget,
): { fields: readonly ManifestField[]; requiredAnyOf?: readonly string[] } {
  const contract = resolved.collection ?? resolved.source;
  if (!contract || contract.routeKey !== routeKey) {
    throw new Error(
      `Research route ${routeKey} has no semantic field contract.`,
    );
  }
  return contract;
}

function buildResearchIntent(
  routeKey: string,
  contract: {
    fields: readonly ManifestField[];
    requiredAnyOf?: readonly string[];
  },
  flags: ParsedFlags,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const fieldByName = new Map(
    contract.fields.map((field) => [field.name, field]),
  );
  for (const field of contract.fields) {
    const key = field.flag!.replace(/^--/u, '');
    if (field.repeatable) {
      const list = flags.arrays.get(key) ?? [];
      if (list.length === 0) {
        if (field.required) {
          throw new Error(
            `Missing required option --${key} for research run ${routeKey}.`,
          );
        }
        continue;
      }
      if (field.format === 'url') {
        list.forEach((value) => assertCliPublicHttpsUrl(key, value));
      }
      input[field.name] = list;
      continue;
    }

    if (field.type === 'boolean') {
      const explicit = flags.booleanValues.get(key);
      if (explicit !== undefined) {
        input[field.name] = explicit;
      } else if (typeof field.default === 'boolean') {
        input[field.name] = field.default;
      }
      continue;
    }

    const raw = flags.values.get(key);
    if (raw === undefined) {
      if (field.default !== undefined) {
        input[field.name] = field.default;
      } else if (field.required) {
        throw new Error(
          `Missing required option --${key} for research run ${routeKey}.`,
        );
      }
      continue;
    }

    if (field.type === 'number') {
      const parsed = Number(raw);
      if (
        !Number.isFinite(parsed) ||
        (field.integer === true && !Number.isInteger(parsed)) ||
        (field.min !== undefined && parsed < field.min) ||
        (field.max !== undefined && parsed > field.max)
      ) {
        throw new Error(`--${key} is outside the supported numeric range.`);
      }
      input[field.name] = parsed;
      continue;
    }

    if (field.enumValues && !field.enumValues.includes(raw)) {
      throw new Error(
        `--${key} must be one of: ${field.enumValues.join(', ')}.`,
      );
    }
    if (field.format === 'url') {
      assertCliPublicHttpsUrl(key, raw);
    }
    input[field.name] = raw;
  }

  if (
    contract.requiredAnyOf &&
    !contract.requiredAnyOf.some((name) => {
      const value = input[name];
      return Array.isArray(value) ? value.length > 0 : value !== undefined;
    })
  ) {
    const accepted = contract.requiredAnyOf.map(
      (name) => fieldByName.get(name)?.flag ?? name,
    );
    throw new Error(
      `research run ${routeKey} requires at least one of: ${accepted.join(', ')}.`,
    );
  }

  return input;
}

function assertCliPublicHttpsUrl(key: string, value: string): void {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') {
      throw new Error('protocol');
    }
  } catch {
    throw new Error(`--${key} must be a valid public HTTPS URL.`);
  }
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
    printOpaquePublishHelp(operation);
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

// ---------------------------------------------------------------------------
// workflow — video-production workflow authoring / read / quote / launch over
// the hosted `workflow` capability envelope. This is the bin counterpart to the
// PostPlus workspace assistant's typed workflow tools: the `workflow-creation`
// released skill drives THIS surface when it runs inside a CLI agent (Claude
// Code / Codex) instead of the workspace assistant. Reads and authoring writes
// are uncharged; `launch` enqueues paid provider runs and is gated client-side
// (see runWorkflowLaunch) — the human-acknowledged ceiling the server re-quotes
// against is the launch's binding cost bound (there is no confirmation token).
// ---------------------------------------------------------------------------

const WORKFLOW_CAPABILITY_PATH = '/api/postplus-cli/hosted/capability';

function workflowOperationId(operation: string): string {
  return `postplus-cli:workflow:${operation}:${randomUUID()}`;
}

function assertKnownWorkflowFlags(
  flags: ParsedFlags,
  allowed: Set<string>,
  command: string,
): void {
  for (const key of [
    ...flags.values.keys(),
    ...flags.booleans,
    ...flags.arrays.keys(),
  ]) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown option for workflow ${command}: --${key}.`);
    }
  }
}

function parseBoundedInt(
  raw: string,
  label: string,
  min: number,
  max: number,
): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parsePositiveInt(raw: string, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${label} must be a positive integer.`);
  }
  return parsed;
}

function parsePositiveCreditsAsMillicredits(
  raw: string,
  label: string,
): number {
  const credits = Number(raw);
  const millicredits = Math.round(credits * 1_000);
  if (
    !Number.isFinite(credits) ||
    credits <= 0 ||
    !Number.isSafeInteger(millicredits) ||
    millicredits <= 0
  ) {
    throw new Error(`--${label} must be a positive PostPlus credit amount.`);
  }
  return millicredits;
}

// Split a required leading `<id>` positional off a workflow subcommand's args.
function takeWorkflowId(
  rest: string[],
  command: string,
): { id: string; flagArgs: string[] } {
  const [id, ...flagArgs] = rest;
  if (!id || id.startsWith('--')) {
    throw new Error(
      `workflow ${command} requires an id: postplus workflow ${command} <id>.`,
    );
  }
  return { id, flagArgs };
}

// One dispatch path for every workflow verb: build the capability envelope, POST
// it through the SAME bin transport the other hosted commands use (disk session
// auth + single 401 refresh + product-error taxonomy), and surface the verb's
// `output` payload (the route wraps it in the uncharged billing envelope). No
// quote-confirmation or async-resume handling — workflow verbs are synchronous
// and uncharged, and launch never returns a 402 challenge.
async function runWorkflowVerb(input: {
  operation: string;
  fields: Record<string, unknown>;
  json: boolean;
  outputPath: string | null;
}): Promise<number> {
  const body = {
    capability: 'workflow',
    operation: input.operation,
    operationId: workflowOperationId(input.operation),
    ...input.fields,
  };
  const exitCode = await dispatchHostedCommand(
    {
      request: async () => {
        const payload = await postHostedJson({
          body,
          pathName: WORKFLOW_CAPABILITY_PATH,
          skillName: null,
        });
        return payload && typeof payload === 'object' && 'output' in payload
          ? (payload as { output: unknown }).output
          : payload;
      },
      errorInputLabel: `workflow ${input.operation}`,
      json: input.json,
      outputPath: input.outputPath,
    },
    undefined,
  );
  return exitCode as number;
}

function readWorkflowOutputPath(flags: ParsedFlags): string | null {
  return flags.values.get('output') ?? null;
}

async function runWorkflowList(rest: string[]): Promise<number> {
  const flags = parseFlags(rest, new Set(['json']));
  assertKnownWorkflowFlags(
    flags,
    new Set(['json', 'output', 'search', 'limit']),
    'list',
  );
  const fields: Record<string, unknown> = {};
  const search = flags.values.get('search');
  if (search) {
    fields.search = search;
  }
  const limit = flags.values.get('limit');
  if (limit !== undefined) {
    fields.limit = parseBoundedInt(limit, 'limit', 1, 50);
  }
  return runWorkflowVerb({
    fields,
    json: flags.booleans.has('json'),
    operation: 'list',
    outputPath: readWorkflowOutputPath(flags),
  });
}

async function runWorkflowShow(rest: string[]): Promise<number> {
  const { id: workflowId, flagArgs } = takeWorkflowId(rest, 'show');
  const flags = parseFlags(flagArgs, new Set(['json']));
  assertKnownWorkflowFlags(flags, new Set(['json', 'output']), 'show');
  return runWorkflowVerb({
    fields: { workflowId },
    json: flags.booleans.has('json'),
    operation: 'get',
    outputPath: readWorkflowOutputPath(flags),
  });
}

async function runWorkflowRuns(rest: string[]): Promise<number> {
  // The workflow id is an OPTIONAL leading positional; omit it to list runs
  // across every workflow in the account.
  const [maybeId, ...maybeFlags] = rest;
  const hasId = maybeId !== undefined && !maybeId.startsWith('--');
  const flags = parseFlags(hasId ? maybeFlags : rest, new Set(['json']));
  assertKnownWorkflowFlags(flags, new Set(['json', 'output', 'limit']), 'runs');
  const fields: Record<string, unknown> = {};
  if (hasId) {
    fields.workflowId = maybeId;
  }
  const limit = flags.values.get('limit');
  if (limit !== undefined) {
    fields.limit = parseBoundedInt(limit, 'limit', 1, 50);
  }
  return runWorkflowVerb({
    fields,
    json: flags.booleans.has('json'),
    operation: 'runs-list',
    outputPath: readWorkflowOutputPath(flags),
  });
}

async function runWorkflowRunShow(rest: string[]): Promise<number> {
  const { id: runId, flagArgs } = takeWorkflowId(rest, 'run-show');
  const flags = parseFlags(flagArgs, new Set(['json']));
  assertKnownWorkflowFlags(flags, new Set(['json', 'output']), 'run-show');
  return runWorkflowVerb({
    fields: { runId },
    json: flags.booleans.has('json'),
    operation: 'runs-get',
    outputPath: readWorkflowOutputPath(flags),
  });
}

async function runWorkflowCreate(rest: string[]): Promise<number> {
  const flags = parseFlags(rest, new Set(['json']));
  assertKnownWorkflowFlags(
    flags,
    new Set(['json', 'output', 'name', 'description', 'template']),
    'create',
  );
  const fields: Record<string, unknown> = { name: requireFlag(flags, 'name') };
  const description = flags.values.get('description');
  if (description) {
    fields.description = description;
  }
  const template = flags.values.get('template');
  if (template) {
    fields.templateId = template;
  }
  return runWorkflowVerb({
    fields,
    json: flags.booleans.has('json'),
    operation: 'create',
    outputPath: readWorkflowOutputPath(flags),
  });
}

// propose (edit-propose: preview + validate, persists nothing) and
// save (version-save: persists a new immutable version) share one shape: a
// `<workflow-id>` positional plus a `--operations <file.json>` array of edit ops.
async function runWorkflowEdit(
  rest: string[],
  operation: 'edit-propose' | 'version-save',
): Promise<number> {
  const command = operation === 'edit-propose' ? 'propose' : 'save';
  const { id: workflowId, flagArgs } = takeWorkflowId(rest, command);
  const flags = parseFlags(flagArgs, new Set(['json']));
  assertKnownWorkflowFlags(
    flags,
    new Set(['json', 'output', 'operations', 'base-version']),
    command,
  );
  const operations = await readJsonFile(requireFlag(flags, 'operations'));
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error(
      `workflow ${command} --operations must be a non-empty JSON array of edit operations ` +
        '(add_node / update_node / remove_node / connect_nodes).',
    );
  }
  const fields: Record<string, unknown> = { operations, workflowId };
  const baseVersion = flags.values.get('base-version');
  if (baseVersion !== undefined) {
    fields.baseVersionNumber = parsePositiveInt(baseVersion, 'base-version');
  }
  return runWorkflowVerb({
    fields,
    json: flags.booleans.has('json'),
    operation,
    outputPath: readWorkflowOutputPath(flags),
  });
}

async function runWorkflowQuote(rest: string[]): Promise<number> {
  const { id: workflowId, flagArgs } = takeWorkflowId(rest, 'quote');
  const flags = parseFlags(flagArgs, new Set(['json']));
  assertKnownWorkflowFlags(
    flags,
    new Set(['json', 'output', 'instances']),
    'quote',
  );
  const instanceCount = parseBoundedInt(
    requireFlag(flags, 'instances'),
    'instances',
    1,
    5,
  );
  return runWorkflowVerb({
    fields: { instanceCount, workflowId },
    json: flags.booleans.has('json'),
    operation: 'run-quote',
    outputPath: readWorkflowOutputPath(flags),
  });
}

// launch enqueues PAID provider runs. This is the CLI equivalent of the
// workspace assistant's human approval card: launching is refused unless the
// operator has quoted the cost first and confirms explicitly. `--confirm` is
// mandatory (its presence in the command is the visible spend acknowledgement an
// agent host surfaces to the human), and `--max-reserved-credits` is the
// acknowledged product-unit ceiling — the server re-quotes atomically and aborts if the fresh
// reservation exceeds it, so the confirmed bound stays binding.
async function runWorkflowLaunch(rest: string[]): Promise<number> {
  const { id: workflowId, flagArgs } = takeWorkflowId(rest, 'launch');
  const flags = parseFlags(flagArgs, new Set(['json', 'confirm']));
  assertKnownWorkflowFlags(
    flags,
    new Set([
      'json',
      'output',
      'confirm',
      'title',
      'instances',
      'max-reserved-credits',
    ]),
    'launch',
  );
  const workflowTitle = requireFlag(flags, 'title');
  const instanceCount = parseBoundedInt(
    requireFlag(flags, 'instances'),
    'instances',
    1,
    5,
  );
  const maxTotalReservedMillicredits = parsePositiveCreditsAsMillicredits(
    requireFlag(flags, 'max-reserved-credits'),
    'max-reserved-credits',
  );

  if (!flags.booleans.has('confirm')) {
    throw new Error(
      [
        'Refusing to launch: launching spends real credits and needs explicit confirmation.',
        `First quote the cost:  postplus workflow quote ${workflowId} --instances ${instanceCount}`,
        'Then re-run launch with that quote’s reservedCredits as the ceiling and --confirm:',
        `  postplus workflow launch ${workflowId} --title "${workflowTitle}" --instances ${instanceCount} --max-reserved-credits <reservedCredits> --confirm`,
      ].join('\n'),
    );
  }

  return runWorkflowVerb({
    fields: {
      instanceCount,
      maxTotalReservedMillicredits,
      workflowId,
      workflowTitle,
    },
    json: flags.booleans.has('json'),
    operation: 'run-launch',
    outputPath: readWorkflowOutputPath(flags),
  });
}

function printWorkflowHelp(): void {
  process.stdout.write(`PostPlus CLI - workflow commands

Author, read, quote, and launch video-production workflows on your account —
the bin surface the workflow-creation skill drives inside a CLI agent. Results
are JSON. Reads and authoring writes are free; launch spends credits.

Usage:
  postplus workflow list [--search <text>] [--limit <n>] [--json] [--output <result.json>]
  postplus workflow show <workflow-id> [--json] [--output <result.json>]
  postplus workflow create --name <name> [--description <text>] [--template <id>] [--output <result.json>]
  postplus workflow propose <workflow-id> --operations <ops.json> [--base-version <n>] [--output <result.json>]
  postplus workflow save <workflow-id> --operations <ops.json> [--base-version <n>] [--output <result.json>]
  postplus workflow quote <workflow-id> --instances <n> [--json] [--output <result.json>]
  postplus workflow launch <workflow-id> --title <exact-name> --instances <n> --max-reserved-credits <credits> --confirm [--json] [--output <result.json>]
  postplus workflow runs [<workflow-id>] [--limit <n>] [--json] [--output <result.json>]
  postplus workflow run-show <run-id> [--json] [--output <result.json>]

--operations is a JSON array of edit ops (add_node / update_node / remove_node /
connect_nodes); the server validates and never silently repairs. launch is
refused without --confirm: quote first, then pass the quote's reservedCredits
as --max-reserved-credits and --confirm to acknowledge the spend.
`);
}

export async function runWorkflowCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case 'list':
      return runWorkflowList(rest);
    case 'show':
      return runWorkflowShow(rest);
    case 'runs':
      return runWorkflowRuns(rest);
    case 'run-show':
      return runWorkflowRunShow(rest);
    case 'create':
      return runWorkflowCreate(rest);
    case 'propose':
      return runWorkflowEdit(rest, 'edit-propose');
    case 'save':
      return runWorkflowEdit(rest, 'version-save');
    case 'quote':
      return runWorkflowQuote(rest);
    case 'launch':
      return runWorkflowLaunch(rest);
    default:
      printWorkflowHelp();
      return subcommand === undefined || isHelp(subcommand) ? 0 : 1;
  }
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
        ? new Set(['route'])
        : new Set<string>();

  for (const key of flags.values.keys()) {
    if (!allowedFlags.has(key)) {
      throw new Error(`Unknown option for ${domain} schema: --${key}.`);
    }
  }

  const report = buildHostedRequestSchemaReport({
    domain,
    endpointKey: flags.values.get('endpoint') ?? null,
    routeKey: flags.values.get('route') ?? null,
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
  debug?: boolean;
  pathName: string;
  skillName: string | null;
  timeoutMs?: number;
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
        ...(input.debug !== undefined ? { debug: input.debug } : {}),
        method: 'POST',
        pathName: input.pathName,
        skillName: input.skillName,
        skillsReleaseId: input.context.skillsReleaseId ?? null,
        timeoutMs: input.timeoutMs ?? 120000,
      })
    : await sendAuthedCloudRequest({
        auth: await resolveFreshRemoteAuth(),
        body: input.body,
        ...(input.debug !== undefined ? { debug: input.debug } : {}),
        method: 'POST',
        pathName: input.pathName,
        retryOn401: () => resolveFreshRemoteAuth({ forceRefresh: true }),
        skillName: input.skillName,
        timeoutMs: input.timeoutMs ?? 120000,
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
      await clearUpdateCheckCache();
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
  // A resume checkpoint is durable input, not an error sink. If a status read
  // fails, keep the last valid handle on disk so the caller can retry after the
  // underlying problem is fixed. --json still receives the structured error on
  // stdout; human mode keeps the existing actionable stderr message.
  preserveOutputOnProductError?: boolean | (() => boolean);
  preservedOutputRecovery?: () => string | null;
  // When an async submit remains pending, render its next safe action. Media
  // keeps its short literal id; research emits only --resume-from <checkpoint>
  // so an agent never rewrites a signed opaque handle. stderr is used in both
  // human and --json modes without changing the server payload on stdout.
  asyncResume?: (payload: unknown) => string | null;
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
          // The confirmation token is server-signed against the challenged
          // operation id. Re-running without --hosted-operation-id mints a fresh
          // random operation id (see the operationId flag default), so the token
          // would no longer match and the confirmation fails. The rerun MUST pin
          // the same operation id the token is bound to.
          'Then rerun the hosted command with the same operation id the token is bound to:',
          `  --hosted-operation-id ${error.challenge.operationId} --quote-confirmation-token <token>`,
        ].join('\n'),
      );
    }

    if (error instanceof HostedProductRequestError) {
      if (shouldPreserveHostedOutput(input.preserveOutputOnProductError)) {
        if (input.json) {
          await writeResult({ error: error.productError }, null, true);
        }
        writePreservedOutputRecovery(input.preservedOutputRecovery);
      } else {
        await writeResult(
          { error: error.productError },
          input.outputPath,
          input.json,
        );
      }
      process.stderr.write(`${error.message}\n`);
      return 1;
    }

    if (shouldPreserveHostedOutput(input.preserveOutputOnProductError)) {
      writePreservedOutputRecovery(input.preservedOutputRecovery);
    }

    throw error;
  }

  await writeResult(payload, input.outputPath, input.json);

  const resumeCommand = input.asyncResume?.(payload) ?? null;
  if (resumeCommand) {
    process.stderr.write(`Async run pending — resume: ${resumeCommand}\n`);
  }

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
    preserveOutputOnProductError?: boolean | (() => boolean);
    preservedOutputRecovery?: () => string | null;
    asyncResume?: (payload: unknown) => string | null;
  },
  context: HostedRequestContext | undefined,
): Promise<number | unknown> {
  if (!context) {
    return runHostedCommand(input);
  }
  return input.request();
}

function shouldPreserveHostedOutput(
  value: boolean | (() => boolean) | undefined,
): boolean {
  return typeof value === 'function' ? value() : value === true;
}

function writePreservedOutputRecovery(
  buildRecovery: (() => string | null) | undefined,
): void {
  const recovery = buildRecovery?.() ?? null;
  if (recovery) {
    process.stderr.write(`${recovery}\n`);
  }
}

// Resume-command extractors (plan E). A media-generation submit returns the run
// handle as `output.data.id`; a research collect/scrape launch returns it as a
// top-level `runHandle`. Both may also come back already terminal (small/sync
// jobs), in which case there is nothing to resume and we stay silent.
const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'succeeded',
  'success',
  'failed',
  'error',
  'expired',
  'canceled',
  'cancelled',
]);

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status.toLowerCase());
}

// Shell-escape an argument value for a copy-pasteable command snippet: wrap in
// single quotes and escape any embedded single quote, so spaces or shell
// metacharacters in a run id can't break or unsafely alter a pasted command.
function shellQuoteArg(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

// Read the `{ id, status }` run projection out of a media-generation payload
// (`output.data`). Shared by the submit resume hint and the poll wait loop; a
// payload without the projection yields nulls so callers fail safe (no resume
// hint, no blind wait loop).
function readMediaPollRun(payload: unknown): {
  id: string | null;
  status: string | null;
} {
  const none = { id: null, status: null };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return none;
  }
  const output = (payload as Record<string, unknown>).output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return none;
  }
  const data = (output as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return none;
  }
  const record = data as Record<string, unknown>;
  return {
    id: typeof record.id === 'string' && record.id.trim() ? record.id : null,
    status:
      typeof record.status === 'string' && record.status.trim()
        ? record.status
        : null,
  };
}

function extractMediaPollResume(
  payload: unknown,
  outputPath: string | null,
): string | null {
  const { id, status } = readMediaPollRun(payload);
  if (!id) {
    return null;
  }
  if (status && isTerminalRunStatus(status)) {
    return null;
  }
  return `postplus media poll --handle ${shellQuoteArg(id)}${
    outputPath ? ` --output ${shellQuoteArg(outputPath)}` : ''
  }`;
}

function extractResearchResume(
  payload: unknown,
  verb: ResearchVerb,
  outputPath: string | null,
): string | null {
  const { runHandle, status } = readResearchRun(payload);
  if (!runHandle || !outputPath) {
    return null;
  }
  if (status && isTerminalRunStatus(status)) {
    return null;
  }
  return `postplus research ${verb} --resume-from ${shellQuoteArg(
    path.resolve(outputPath),
  )}`;
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
    const absoluteOutput = path.resolve(outputPath);
    const outputDirectory = path.dirname(absoluteOutput);
    const temporaryOutput = path.join(
      outputDirectory,
      `.${path.basename(absoluteOutput)}.postplus-result-${randomUUID()}.tmp`,
    );
    await mkdir(outputDirectory, { recursive: true });
    try {
      await writeFile(temporaryOutput, text, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryOutput, absoluteOutput);
    } finally {
      await rm(temporaryOutput, { force: true }).catch(() => {});
    }
  }
}

function parseFlags(
  args: string[],
  booleanFlags: Set<string>,
  arrayFlags: Set<string> = new Set(),
): ParsedFlags {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const booleanValues = new Map<string, boolean>();
  const arrays = new Map<string, string[]>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (booleanFlags.has(key)) {
      // Optional explicit value: `--flag true|false`. Bare presence = true.
      const next = args[index + 1];
      if (next === 'true' || next === 'false') {
        booleanValues.set(key, next === 'true');
        if (next === 'true') {
          booleans.add(key);
        } else {
          booleans.delete(key);
        }
        index += 1;
        continue;
      }
      booleans.add(key);
      booleanValues.set(key, true);
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

  return { arrays, booleanValues, booleans, values };
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
  postplus research run <route> --<semantic flags> --wait --output <result.json>
  postplus research run --resume-from <result.json> [--wait-seconds <n>] [--poll-interval-seconds <n>] [--json]
  postplus research schema [--route <route>] [--json]

Run \`postplus research run <route> --help\` for route-specific flags.
`);
}

function printDomainVerbHelp(domain: Exclude<HostedDomain, 'research'>): void {
  const verbUsage =
    domain === 'media'
      ? [...MEDIA_VERB_ENDPOINTS.keys()]
          .map(
            (verb) =>
              `  postplus media ${verb} <endpoint-key> --<intent/default flags> [--wait] [--json] [--output <result.json>]\n`,
          )
          .join('') +
        '  postplus media estimate <endpoint-key> --<same flags/--request as matching submit verb> [--json]\n' +
        '  postplus media poll --handle <run-id> [--wait-seconds <n>] [--poll-interval-seconds <n>] [--debug] [--json] [--output <result.json>]\n' +
        '    (poll waits in-command: re-checks every 8s until terminal or the 45s default budget ends; --wait-seconds 0 = single check)\n'
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
  // video-analysis uses normalized role flags; execution details stay server-side.
  if (resolved.capability === 'video-analysis') {
    const fields = resolved.model?.fields ?? [];
    process.stdout.write(`PostPlus CLI - ${domain} ${verb} ${targetKey}

  Surface: flags (normalized media intent)
  Usage:
    postplus ${domain} ${verb} ${targetKey} ${formatFlagsUsage(fields)} [--video-seconds <n>] [--json] [--output <result.json>]

  --video <video>    Local path, PostPlus media reference, or video data URI.
                    The CLI stages local bytes before the analysis submit.
  --prompt <text>    The analysis question or requested evidence structure.
  --video-seconds <n>  Optional source video duration in seconds. Supplying it
                    helps PostPlus validate and route the request; omit it when
                    the duration is unknown.
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
      ? `    postplus ${domain} ${verb} ${targetKey} ${formatFlagsUsage(fields)} [--wait] [--json] [--output <result.json>]`
      : `    postplus ${domain} ${verb} ${targetKey} --request <input.json> [--wait] [--json] [--output <result.json>]`,
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
    // Boolean flags: bare presence = true, optional explicit `true|false` value
    // (the only way to switch a default-true boolean off).
    const token =
      field.type === 'boolean'
        ? `${field.flag} [true|false]`
        : `${field.flag} <${field.name}>`;
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
    field.type === 'media-url'
      ? `${field.mediaKind ?? 'media'} input${field.repeatable ? '[]' : ''}: local path | HTTPS | PostPlus media reference | data URI`
      : field.repeatable
        ? `${field.type}[]`
        : field.type,
    field.required ? 'required' : 'optional',
  ];
  if (field.enumValues && field.enumValues.length > 0) {
    detail.push(`one of {${field.enumValues.join(', ')}}`);
  } else if (field.min !== undefined || field.max !== undefined) {
    detail.push(
      `range ${field.min ?? '-'}..${field.max ?? '-'}${
        field.specialValues?.length
          ? ` or {${field.specialValues.join(', ')}}`
          : ''
      }`,
    );
  }
  if (
    field.repeatable &&
    (field.minItems !== undefined || field.maxItems !== undefined)
  ) {
    detail.push(`items ${field.minItems ?? 0}..${field.maxItems ?? '∞'}`);
  }
  if (field.default !== undefined) {
    detail.push(`default ${String(field.default)}`);
  }
  return `  [${detail.join('; ')}]`;
}

function printResearchRouteHelp(
  routeKey: string,
  resolved: ResolvedVerbTarget,
): void {
  const contract = readResolvedResearchContract(routeKey, resolved);
  const lines = [
    `PostPlus CLI - research run ${routeKey}`,
    '',
    '  Usage:',
    `    postplus research run ${routeKey} ${formatFlagsUsage(contract.fields)} --wait --output <result.json>`,
    '',
    '  Research intent:',
  ];
  for (const field of contract.fields) {
    lines.push(
      `    ${field.flag}${formatFieldDetail(field)}${field.description ? `  ${field.description}` : ''}`,
    );
  }
  if (contract.requiredAnyOf) {
    const names = new Map(
      contract.fields.map((field) => [field.name, field.flag]),
    );
    lines.push(
      '',
      `  At least one required: ${contract.requiredAnyOf.map((name) => names.get(name) ?? name).join(', ')}`,
    );
  }
  lines.push(
    '',
    '  Request translation, credit safeguards, and polling internals are handled by PostPlus.',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

// Per-target help for the remaining opaque publishing JSON surface.
function printOpaquePublishHelp(targetKey: string): void {
  const inputShape = 'a product request JSON object';
  const header = `publish ${targetKey}`;
  const usage = `    postplus publish ${targetKey} --request <input.json> [--json] [--output <result.json>]`;

  process.stdout.write(`PostPlus CLI - ${header}

  Surface: request-json (opaque input authored by the agent)
  Capability: social-publishing
  Usage:
${usage}

  --request <file>  ${inputShape}.
  Runner-managed (minted by the CLI; never in the body): operationId, quoteConfirmationToken
`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
