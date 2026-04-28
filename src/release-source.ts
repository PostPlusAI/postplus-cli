import { type ReleaseManifest } from './postplus-release.js';

import {
  loadHostedReleaseManifest,
  requireHostedBaseUrl,
} from './hosted-release.js';

export type ReleaseManifestSource = {
  kind: 'hosted-release';
  baseUrl: string;
  manifest: ReleaseManifest;
};

export async function loadHostedReleaseManifestSource(): Promise<ReleaseManifestSource> {
  const baseUrl = await requireHostedBaseUrl();
  return {
    kind: 'hosted-release',
    baseUrl,
    manifest: await loadHostedReleaseManifest(baseUrl),
  };
}
