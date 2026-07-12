// Single typed reader over the generated hosted execution manifest (the SSOT
// projected from apps/web + public-skill-metadata). The CLI verb/flag grammar,
// the schema report, and the per-endpoint `--help` all index the manifest through
// this module so the discovery surface never hand-maintains a mirror of enum sets,
// defaults, or the intent/default/runner-managed field classification.

import { HOSTED_EXECUTION_MANIFESTS } from './generated/hosted-execution-manifest.generated.js';

export type HostedDomain = 'media' | 'publish' | 'research';

export type ManifestFieldClass = 'intent' | 'default' | 'runner-managed';

export type ManifestField = {
  name: string;
  class: ManifestFieldClass;
  flag: string | null;
  type: 'string' | 'number' | 'boolean' | 'media-url';
  repeatable?: boolean;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  // How a string value is normalized before the early enum check compares it against
  // enumValues (issue #475). Projected verbatim from the Web EnvelopeFieldSpec hint —
  // the single source both the Web validator and this CLI early validator read — so
  // the two sides can never drift on casing. See hosted-field-validation.ts.
  canonicalize?: 'lowercase' | 'image-resolution-tier';
  default?: string | number | boolean;
  required: boolean;
  derivedFrom?: string;
};

export type ManifestEndpoint = {
  endpointKey: string;
  provider: string;
  providerModelPath: string;
  fields: readonly ManifestField[];
  billingDimensions?: readonly string[];
};

export type ManifestModel = {
  modelKey: string;
  providerModelPath: string;
};

export type ManifestCollection = {
  collectionKey: string;
  actorId: string;
};

export type ManifestSource = {
  sourceKey: string;
  datasetId: string;
};

export type ManifestOperation = {
  operation: string;
};

// One execution binding from the generated manifest. media-generation entries
// carry `endpoints`; video-analysis entries carry `models`; hosted-collection
// entries carry `collections`; public-content-collection entries carry `sources`;
// social-publishing entries carry `operations`.
export type ManifestEntry = {
  skill: string;
  mode?: 'cli-runner';
  surface: 'flags' | 'request-json';
  verb: string;
  domain: HostedDomain;
  capability: string;
  endpointKeys?: readonly string[];
  modelKeys?: readonly string[];
  collectionKeys?: readonly string[];
  sourceKeys?: readonly string[];
  endpoints?: readonly ManifestEndpoint[];
  models?: readonly ManifestModel[];
  collections?: readonly ManifestCollection[];
  sources?: readonly ManifestSource[];
  operations?: readonly ManifestOperation[];
};

const HOSTED_EXECUTION_MANIFEST_INDEX: Readonly<
  Record<string, readonly ManifestEntry[]>
> = HOSTED_EXECUTION_MANIFESTS;

// A resolved (verb, target) entry. media-generation resolves to an `endpoint`;
// video-analysis resolves to a `model`; hosted-collection resolves to a
// `collection`; public-content-collection resolves to a `source`; the publish
// operation is both the subcommand and the target. capability discriminates them
// so callers route to the right input surface.
export type ResolvedVerbTarget = {
  skill: string;
  capability: string;
  surface: 'flags' | 'request-json';
  endpoint?: ManifestEndpoint;
  model?: ManifestModel;
  collection?: ManifestCollection;
  source?: ManifestSource;
  operation?: string;
};

export function allManifestEntries(): ManifestEntry[] {
  return Object.values(HOSTED_EXECUTION_MANIFEST_INDEX).flat();
}

// Verb -> targetKey -> resolved target for one domain. media indexes endpoints
// (and the video-analysis model under its own verb); research indexes
// collections under `collect` and sources under `scrape`.
export function buildVerbTargetIndex(
  domain: HostedDomain,
): Map<string, Map<string, ResolvedVerbTarget>> {
  const index = new Map<string, Map<string, ResolvedVerbTarget>>();

  for (const entry of allManifestEntries()) {
    if (entry.domain !== domain) {
      continue;
    }

    let targets = index.get(entry.verb);
    if (!targets) {
      targets = new Map<string, ResolvedVerbTarget>();
      index.set(entry.verb, targets);
    }

    const base = {
      skill: entry.skill,
      capability: entry.capability,
      surface: entry.surface,
    } as const;

    if (entry.capability === 'video-analysis') {
      for (const model of entry.models ?? []) {
        targets.set(model.modelKey, { ...base, model });
      }
      continue;
    }

    if (entry.capability === 'hosted-collection') {
      for (const collection of entry.collections ?? []) {
        targets.set(collection.collectionKey, { ...base, collection });
      }
      continue;
    }

    if (entry.capability === 'public-content-collection') {
      for (const source of entry.sources ?? []) {
        targets.set(source.sourceKey, { ...base, source });
      }
      continue;
    }

    if (entry.capability === 'social-publishing') {
      for (const { operation } of entry.operations ?? []) {
        targets.set(operation, { ...base, operation });
      }
      continue;
    }

    for (const endpoint of entry.endpoints ?? []) {
      targets.set(endpoint.endpointKey, { ...base, endpoint });
    }
  }

  return index;
}

// Sorted unique target keys for one domain, optionally narrowed to a capability.
// Used by the schema report to publish the FULL enum set of selectable targets
// (every endpointKey / modelKey / collectionKey / sourceKey / operation) instead
// of a single example, and by the JSON schema to constrain the selector to an enum.
export function manifestTargetKeys(
  domain: HostedDomain,
  capability?: string,
): string[] {
  const keys = new Set<string>();

  for (const entry of allManifestEntries()) {
    if (entry.domain !== domain) {
      continue;
    }
    if (capability && entry.capability !== capability) {
      continue;
    }

    for (const endpoint of entry.endpoints ?? []) {
      keys.add(endpoint.endpointKey);
    }
    for (const model of entry.models ?? []) {
      keys.add(model.modelKey);
    }
    for (const collection of entry.collections ?? []) {
      keys.add(collection.collectionKey);
    }
    for (const source of entry.sources ?? []) {
      keys.add(source.sourceKey);
    }
    for (const operation of entry.operations ?? []) {
      keys.add(operation.operation);
    }
  }

  return [...keys].sort();
}

// Sorted endpoint keys of the given capability whose manifest fields expose the
// given flag. Used by the unknown-flag rejection to hint which sibling endpoints
// DO accept a flag the selected endpoint rejected (e.g. `--reference-image` is
// declared only on edit endpoints, so a text-endpoint submit can name them
// instead of reading as "this CLI has no such capability").
export function capabilityEndpointsWithFlag(
  capability: string,
  flag: string,
): string[] {
  const keys = new Set<string>();
  for (const entry of allManifestEntries()) {
    if (entry.capability !== capability) {
      continue;
    }
    for (const endpoint of entry.endpoints ?? []) {
      if (endpoint.fields.some((field) => field.flag === flag)) {
        keys.add(endpoint.endpointKey);
      }
    }
  }
  return [...keys].sort();
}

// Resolves the endpoint contract for a media-generation endpointKey, or null when
// the key is not a modelled media-generation endpoint. Used by the schema report
// and per-endpoint `--help` to read the field-level contract.
export function findMediaEndpoint(endpointKey: string): ManifestEndpoint | null {
  return findMediaGenerationBinding(endpointKey)?.endpoint ?? null;
}

// The verb + input surface that owns a media-generation endpoint. The schema
// report needs the verb to synthesize a copy-pasteable `postplus media <verb>
// <endpoint-key> …` example, and the surface to choose the flags vs --request
// form. Returns null for an unknown key.
export type MediaGenerationBinding = {
  verb: string;
  surface: 'flags' | 'request-json';
  endpoint: ManifestEndpoint;
};

export function findMediaGenerationBinding(
  endpointKey: string,
): MediaGenerationBinding | null {
  for (const entry of allManifestEntries()) {
    if (entry.domain !== 'media' || entry.capability !== 'media-generation') {
      continue;
    }
    for (const endpoint of entry.endpoints ?? []) {
      if (endpoint.endpointKey === endpointKey) {
        return { verb: entry.verb, surface: entry.surface, endpoint };
      }
    }
  }
  return null;
}
