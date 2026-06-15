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
  default?: string | number | boolean;
  required: boolean;
  derivedFrom?: string;
};

export type ManifestEndpoint = {
  endpointKey: string;
  fields: readonly ManifestField[];
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
  surface: 'flags' | 'request-json';
  verb: string;
  domain: HostedDomain;
  capability: string;
  endpoints?: readonly ManifestEndpoint[];
  models?: readonly ManifestModel[];
  collections?: readonly ManifestCollection[];
  sources?: readonly ManifestSource[];
  operations?: readonly ManifestOperation[];
};

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
  return Object.values(HOSTED_EXECUTION_MANIFESTS).flat() as unknown as ManifestEntry[];
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

// Resolves the endpoint contract for a media-generation endpointKey, or null when
// the key is not a modelled media-generation endpoint. Used by the schema report
// and per-endpoint `--help` to read the field-level contract.
export function findMediaEndpoint(endpointKey: string): ManifestEndpoint | null {
  for (const entry of allManifestEntries()) {
    if (entry.domain !== 'media' || entry.capability !== 'media-generation') {
      continue;
    }
    for (const endpoint of entry.endpoints ?? []) {
      if (endpoint.endpointKey === endpointKey) {
        return endpoint;
      }
    }
  }
  return null;
}
