import { Buffer } from 'node:buffer';

import {
  type HostedDomain,
  type ManifestEndpoint,
  type ManifestField,
  findMediaEndpoint,
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
  required: boolean;
  repeatable?: boolean;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  // Casing-normalization hint for the enum check, projected from the manifest so the
  // discovery surface documents the accepted casing (e.g. resolution "720P" == "720p").
  canonicalize?: 'lowercase' | 'image-resolution-tier';
  default?: string | number | boolean;
  derivedFrom?: string;
};

// A selectable endpoint's full field contract. The schema report carries this for
// every modelled media-generation endpoint so the agent reads the authoritative
// enum sets / defaults / classification instead of a single illustrative example.
type EndpointContract = {
  endpointKey: string;
  fields: FieldContract[];
};

type HostedRequestSchemaReport = {
  schemaVersion: 1;
  domain: HostedSchemaDomain;
  command: string;
  description: string;
  // Full enum sets of selectable targets for this domain.
  collectionKeys?: string[];
  endpointKeys?: string[];
  modelKeys?: string[];
  sourceKeys?: string[];
  operations?: string[];
  selectedCollectionKey?: string;
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
  if (field.enumValues) {
    contract.enumValues = field.enumValues;
  }
  if (field.min !== undefined) {
    contract.min = field.min;
  }
  if (field.max !== undefined) {
    contract.max = field.max;
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
  return contract;
}

function toEndpointContract(endpoint: ManifestEndpoint): EndpointContract {
  return {
    endpointKey: endpoint.endpointKey,
    fields: endpoint.fields.map(toFieldContract),
  };
}

export function buildHostedRequestSchemaReport(input: {
  collectionKey?: string | null;
  domain: HostedSchemaDomain;
  endpointKey?: string | null;
}): HostedRequestSchemaReport {
  switch (input.domain) {
    case 'research':
      return buildResearchSchemaReport(input.collectionKey ?? null);
    case 'media':
      return buildMediaSchemaReport(input.endpointKey ?? null);
    case 'publish':
      return buildPublishSchemaReport();
  }
}

function buildResearchSchemaReport(
  collectionKey: string | null,
): HostedRequestSchemaReport {
  const collectionKeys = manifestTargetKeys('research', 'hosted-collection');
  const sourceKeys = manifestTargetKeys(
    'research',
    'public-content-collection',
  );

  if (collectionKey && !collectionKeys.includes(collectionKey)) {
    throw new Error(
      `Unknown research collection ${collectionKey}. Known collections: ${collectionKeys.join(', ')}`,
    );
  }

  return {
    schemaVersion: 1,
    domain: 'research',
    command:
      'postplus research collect <collection-key> --request <input.json> --output <result.json>; postplus research scrape <source-key> --request <input-array.json> --output <result.json>',
    description: 'Schemas for files passed to hosted research commands.',
    collectionKeys,
    selectedCollectionKey: collectionKey ?? undefined,
    sourceKeys,
    notes: [
      'collect / scrape input is an opaque provider-shaped JSON object the agent authors; the collection/source key stays on the CLI flag, not inside the file.',
      'Use --run-handle with research collect for polling instead of a new launch.',
      'Use research scrape <source-key> with a JSON array of records for public-content sources.',
      'The CLI derives operationId before sending requests to PostPlus Cloud.',
    ],
    schemas: [
      {
        id: 'research.collection-input',
        description:
          'Hosted research collection input: the provider-shaped JSON object placed in --request <file>.',
        required: [],
        jsonSchema: JSON_OBJECT_SCHEMA,
      },
      {
        id: 'public-content-collection.scrape-input',
        description:
          'Public-content scrape input: a non-empty JSON array of provider-shaped records placed in --request <file>.',
        required: [],
        jsonSchema: {
          items: JSON_OBJECT_SCHEMA,
          minItems: 1,
          type: 'array',
        },
      },
    ],
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
    ? [toEndpointContract(requireMediaEndpoint(endpointKey))]
    : endpointKeys.map((key) => toEndpointContract(requireMediaEndpoint(key)));

  return {
    schemaVersion: 1,
    domain: 'media',
    command:
      'postplus media <verb> <endpoint-key> --request <input.json> | --<flags> --output <result.json>',
    description: 'Schemas for files passed to hosted media commands.',
    endpointKeys,
    modelKeys,
    selectedEndpointKey: endpointKey ?? undefined,
    notes: [
      'Each media-generation endpoint declares its fields as intent (you write it), default (manifest-defaulted; write only to deviate), or runner-managed (minted by the CLI; no flag, never in the body).',
      'Endpoint-specific input belongs under input; capability / endpointKey come from the verb + positional, not the body.',
      'video-analysis analyze takes an opaque Gemini request object the agent authors verbatim under payload.',
      'The CLI derives operationId and billing dimensions before sending requests to PostPlus Cloud.',
      'Run `postplus media <verb> <endpoint-key> --help` for a single endpoint flag/enum/default breakdown.',
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
        description: 'Run hosted Gemini video analysis.',
        required: ['capability', 'operation', 'modelKey', 'payload'],
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
            payload: JSON_OBJECT_SCHEMA,
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['capability', 'operation', 'modelKey', 'payload'],
          type: 'object',
        },
      },
      {
        id: 'media-file.create-upload-url',
        description:
          'Create a hosted media upload target via `postplus media-file upload`.',
        required: ['capability', 'operation', 'file'],
        jsonSchema: {
          additionalProperties: false,
          properties: {
            capability: { const: 'media-file' },
            file: {
              additionalProperties: false,
              properties: {
                mimeType: { minLength: 1, type: 'string' },
                name: { minLength: 1, type: 'string' },
                sizeBytes: { minimum: 1, type: 'integer' },
              },
              required: ['mimeType', 'name', 'sizeBytes'],
              type: 'object',
            },
            operation: { const: 'create-upload-url' },
            operationId: OPERATION_ID_SCHEMA,
            quoteConfirmationToken: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['capability', 'operation', 'file'],
          type: 'object',
        },
      },
    ],
    endpoints,
  };
}

function requireMediaEndpoint(endpointKey: string): ManifestEndpoint {
  const endpoint = findMediaEndpoint(endpointKey);
  if (!endpoint) {
    throw new Error(
      `hosted-request-schemas: ${endpointKey} is not a modelled media-generation endpoint.`,
    );
  }
  return endpoint;
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
