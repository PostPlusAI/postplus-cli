import { Buffer } from 'node:buffer';

import {
  type HostedDomain,
  type ManifestField,
  type MediaGenerationBinding,
  buildVerbTargetIndex,
  findMediaGenerationBinding,
  manifestTargetKeys,
} from './hosted-manifest-index.js';

type HostedSchemaDomain = HostedDomain;

// A single field's discovery contract, projected from the generated execution
// manifest (the SSOT). `kind` is the three-way envelope classification; the agent
// only writes intent/default. `enumValues` / `min` / `max` / `default` are the
// manifest's resolved-by-reference contract, never a hand-maintained mirror.
type FieldContract = {
  name: string;
  kind: 'intent' | 'default' | 'runner-managed';
  flag: string | null;
  type: 'string' | 'number' | 'boolean' | 'media-url';
  mediaKind?: 'image' | 'video' | 'audio';
  required: boolean;
  repeatable?: boolean;
  minItems?: number;
  maxItems?: number;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  specialValues?: readonly number[];
  // Casing-normalization hint for the enum check, projected from the manifest so the
  // discovery surface documents the accepted casing (e.g. resolution "720P" == "720p").
  canonicalize?: 'lowercase' | 'image-resolution-tier';
  default?: string | number | boolean;
  derivedFrom?: string;
  integer?: boolean;
  format?: 'url';
  description?: string;
};

// A copy-pasteable example synthesized from the endpoint's own contract (required
// fields ∪ {prompt}, each enum taking its first value). It lets an agent go
// discover → inspect → submit in one hop without guessing the field set. The
// `estimate` line prices the SAME request with no charge (plan B/D pairing).
type EndpointExample = {
  command: string;
  request: Record<string, unknown>;
  estimate: string;
};

// A selectable endpoint's full field contract. The schema report carries this for
// every modelled media-generation endpoint so the agent reads the authoritative
// enum sets / defaults / classification instead of a single illustrative example.
type EndpointContract = {
  endpointKey: string;
  fields: FieldContract[];
  example?: EndpointExample;
};

type ResearchRouteContract = {
  routeKey: string;
  fields: FieldContract[];
  requiredAnyOf?: readonly string[];
  example: string;
};

type HostedRequestSchemaReport = {
  schemaVersion: 1;
  domain: HostedSchemaDomain;
  command: string;
  description: string;
  // Full enum sets of selectable targets for this domain.
  routeKeys?: string[];
  endpointKeys?: string[];
  modelKeys?: string[];
  operations?: string[];
  selectedRouteKey?: string;
  selectedEndpointKey?: string;
  notes: string[];
  schemas: Array<{
    id: string;
    description: string;
    required: string[];
    jsonSchema: Record<string, unknown>;
  }>;
  // Per-endpoint field contracts (media domain), or per-target field contract for
  // the selected endpoint. Empty for capabilities whose request body is an opaque
  // JSON object the agent authors verbatim (research collection, video analysis,
  // social publishing).
  endpoints?: EndpointContract[];
  routes?: ResearchRouteContract[];
};

const JSON_OBJECT_SCHEMA = {
  additionalProperties: true,
  type: 'object',
} as const;

const OPERATION_ID_SCHEMA = {
  description: 'Stable idempotency key for this logical operation.',
  minLength: 1,
  type: 'string',
} as const;

function toFieldContract(field: ManifestField): FieldContract {
  const contract: FieldContract = {
    name: field.name,
    kind: field.class,
    flag: field.flag,
    type: field.type,
    required: field.required,
  };
  if (field.repeatable) {
    contract.repeatable = true;
  }
  if (field.mediaKind) {
    contract.mediaKind = field.mediaKind;
  }
  if (field.minItems !== undefined) {
    contract.minItems = field.minItems;
  }
  if (field.maxItems !== undefined) {
    contract.maxItems = field.maxItems;
  }
  if (field.enumValues) {
    contract.enumValues = field.enumValues;
  }
  if (field.min !== undefined) {
    contract.min = field.min;
  }
  if (field.max !== undefined) {
    contract.max = field.max;
  }
  if (field.specialValues) {
    contract.specialValues = field.specialValues;
  }
  if (field.canonicalize) {
    contract.canonicalize = field.canonicalize;
  }
  if (field.default !== undefined) {
    contract.default = field.default;
  }
  if (field.derivedFrom) {
    contract.derivedFrom = field.derivedFrom;
  }
  if (field.integer) {
    contract.integer = true;
  }
  if (field.format) {
    contract.format = field.format;
  }
  if (field.description) {
    contract.description = field.description;
  }
  return contract;
}

function toEndpointContract(binding: MediaGenerationBinding): EndpointContract {
  return {
    endpointKey: binding.endpoint.endpointKey,
    fields: binding.endpoint.fields.map(toFieldContract),
    example: synthesizeEndpointExample(binding),
  };
}

// Synthesize a copy-pasteable example from the endpoint's own contract. The
// example field set is `required ∪ {prompt}` (runner-managed fields excluded —
// the CLI mints those), and every enum field takes its FIRST value. The command
// renders in the endpoint's surface form (flags vs --request) so the agent can
// paste and run it directly, then swap real values in.
function synthesizeEndpointExample(
  binding: MediaGenerationBinding,
): EndpointExample {
  const exampleFields = binding.endpoint.fields.filter(
    (field) =>
      field.class !== 'runner-managed' &&
      (field.required || field.name === 'prompt'),
  );

  const request: Record<string, unknown> = {};
  for (const field of exampleFields) {
    request[field.name] = exampleValueForField(field);
  }

  const base = `postplus media ${binding.verb} ${binding.endpoint.endpointKey}`;
  const command =
    binding.surface === 'flags'
      ? [base, ...exampleFields.map(formatExampleFlag)].join(' ')
      : `${base} --request request.json`;

  const estimate =
    binding.surface === 'flags'
      ? `postplus media estimate ${binding.endpoint.endpointKey} ${exampleFields
          .map(formatExampleFlag)
          .join(' ')} --json`
      : `postplus media estimate ${binding.endpoint.endpointKey} --request request.json --json`;

  return { command, request, estimate };
}

function exampleValueForField(field: ManifestField): unknown {
  const scalar = exampleScalarForField(field);
  return field.repeatable ? [scalar] : scalar;
}

function exampleScalarForField(field: ManifestField): unknown {
  if (field.enumValues && field.enumValues.length > 0) {
    return field.enumValues[0];
  }
  if (field.default !== undefined) {
    return field.default;
  }
  switch (field.type) {
    case 'number':
      if (field.min !== undefined) {
        return field.min;
      }
      return field.max !== undefined ? Math.min(field.max, 1) : 1;
    case 'boolean':
      return true;
    case 'media-url':
      return `./input.${field.mediaKind === 'audio' ? 'mp3' : field.mediaKind === 'video' ? 'mp4' : 'png'}`;
    default:
      return `<${field.name}>`;
  }
}

function formatExampleFlag(field: ManifestField): string {
  const flag = field.flag ?? `--${field.name}`;
  if (field.type === 'boolean') {
    return flag;
  }
  const scalar = exampleScalarForField(field);
  return `${flag} ${formatFlagValue(scalar)}`;
}

function formatFlagValue(value: unknown): string {
  const text = String(value);
  return /\s/u.test(text) ? `"${text}"` : text;
}

export function buildHostedRequestSchemaReport(input: {
  routeKey?: string | null;
  domain: HostedSchemaDomain;
  endpointKey?: string | null;
}): HostedRequestSchemaReport {
  switch (input.domain) {
    case 'research':
      return buildResearchSchemaReport(input.routeKey ?? null);
    case 'media':
      return buildMediaSchemaReport(input.endpointKey ?? null);
    case 'publish':
      return buildPublishSchemaReport();
  }
}

function buildResearchSchemaReport(
  routeKey: string | null,
): HostedRequestSchemaReport {
  const routeTargets = buildVerbTargetIndex('research').get('run');
  const routeKeys = [...(routeTargets?.keys() ?? [])].sort();

  if (routeKey && !routeKeys.includes(routeKey)) {
    throw new Error(
      `Unknown research route ${routeKey}. Known routes: ${routeKeys.join(', ')}`,
    );
  }

  const selectedKeys = routeKey ? [routeKey] : routeKeys;
  const routes = selectedKeys.map((key): ResearchRouteContract => {
    const resolved = routeTargets?.get(key);
    const contract = resolved?.collection ?? resolved?.source;
    if (!contract) {
      throw new Error(`Research route ${key} has no semantic field contract.`);
    }
    const exampleFields = contract.fields.filter(
      (field) => field.required || field.default === undefined,
    );
    return {
      routeKey: key,
      fields: contract.fields.map(toFieldContract),
      ...(contract.requiredAnyOf
        ? { requiredAnyOf: contract.requiredAnyOf }
        : {}),
      example: [
        `postplus research run ${key}`,
        ...exampleFields.map(formatExampleFlag),
        '--wait --output result.json',
      ].join(' '),
    };
  });

  return {
    schemaVersion: 1,
    domain: 'research',
    command:
      'postplus research run <route> --<semantic flags> --wait --output <result.json>',
    description:
      'Manifest-driven semantic contracts for PostPlus research routes.',
    routeKeys,
    selectedRouteKey: routeKey ?? undefined,
    routes,
    notes: [
      'Pass public search terms, URLs, account handles, scope, and limits as route-specific flags; do not create request JSON.',
      'Use research run --resume-from <result.json> instead of launching a pending run again.',
      'PostPlus handles execution routing, request translation, and credit safeguards.',
    ],
    schemas: [],
  };
}

function buildMediaSchemaReport(
  endpointKey: string | null,
): HostedRequestSchemaReport {
  const endpointKeys = manifestTargetKeys('media', 'media-generation');
  const modelKeys = manifestTargetKeys('media', 'video-analysis');

  if (endpointKey && !endpointKeys.includes(endpointKey)) {
    throw new Error(
      `Unknown media endpoint ${endpointKey}. Known endpoints: ${endpointKeys.join(', ')}`,
    );
  }

  // When an endpoint is selected, narrow to that one field contract; otherwise
  // publish every modelled endpoint's field contract.
  const endpoints = endpointKey
    ? [toEndpointContract(requireMediaBinding(endpointKey))]
    : endpointKeys.map((key) => toEndpointContract(requireMediaBinding(key)));

  return {
    schemaVersion: 1,
    domain: 'media',
    command:
      'postplus media <verb> <endpoint-key> --<role/intent flags> [--wait] --output <result.json>',
    description: 'Manifest-driven contracts for hosted media commands.',
    endpointKeys,
    modelKeys,
    selectedEndpointKey: endpointKey ?? undefined,
    notes: [
      'Each media endpoint exposes only supported role and intent flags. Omit optional flags to use the published defaults.',
      'Media role flags accept a local file path directly; the CLI stages local bytes before the single hosted submit.',
      'Video analysis accepts normalized --video and --prompt flags; PostPlus owns the remaining execution details.',
      'PostPlus handles operation identity and credit safeguards before execution.',
      'Run `postplus media <verb> <endpoint-key> --help` for a single endpoint flag/enum/default breakdown.',
      'Each endpoint contract carries a copy-pasteable example (required fields ∪ prompt, enums at their first value) under example.command / example.request.',
      'Estimate PostPlus credits before submitting: example.estimate (or `postplus media estimate <endpoint-key> …`).',
    ],
    schemas: [
      {
        id: 'media-generation.request',
        description: 'Submit an async media generation/transcription job.',
        required: ['capability', 'operation', 'endpointKey', 'input'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            capability: { const: 'media-generation' },
            endpointKey: {
              enum: endpointKeys,
              type: 'string',
            },
            input: JSON_OBJECT_SCHEMA,
            operation: { const: 'request' },
            operationId: OPERATION_ID_SCHEMA,
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['capability', 'operation', 'endpointKey', 'input'],
          type: 'object',
        },
      },
      {
        id: 'video-analysis.analyze',
        description: 'Run hosted video analysis from normalized intent.',
        required: ['capability', 'operation', 'modelKey', 'input'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            capability: { const: 'video-analysis' },
            modelKey: {
              enum: modelKeys,
              type: 'string',
            },
            operation: { const: 'analyze' },
            operationId: OPERATION_ID_SCHEMA,
            input: {
              additionalProperties: false,
              properties: {
                prompt: { minLength: 1, type: 'string' },
                video: { minLength: 1, type: 'string' },
              },
              required: ['prompt', 'video'],
              type: 'object',
            },
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['capability', 'operation', 'modelKey', 'input'],
          type: 'object',
        },
      },
    ],
    endpoints,
  };
}

function requireMediaBinding(endpointKey: string): MediaGenerationBinding {
  const binding = findMediaGenerationBinding(endpointKey);
  if (!binding) {
    throw new Error(
      `hosted-request-schemas: ${endpointKey} is not a modelled media-generation endpoint.`,
    );
  }
  return binding;
}

function buildPublishSchemaReport(): HostedRequestSchemaReport {
  const operations = manifestTargetKeys('publish', 'social-publishing');

  return {
    schemaVersion: 1,
    domain: 'publish',
    command:
      'postplus publish <operation> --request <input.json> --output <result.json>',
    description: 'Schema for files passed to hosted publish commands.',
    operations,
    notes: [
      'The operation is BOTH the CLI subcommand and the target; the operation-specific publishing payload goes under input in --request <file>.',
      'Side-effecting operations may surface a quote-confirmation challenge; replay the fixed confirm/retry commands.',
    ],
    schemas: [
      {
        id: 'social-publishing.request',
        description: 'Run a hosted social publishing operation.',
        required: ['capability', 'operation', 'input'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            capability: { const: 'social-publishing' },
            input: JSON_OBJECT_SCHEMA,
            operation: {
              enum: operations,
              type: 'string',
            },
            operationId: OPERATION_ID_SCHEMA,
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['capability', 'operation', 'input'],
          type: 'object',
        },
      },
    ],
  };
}
