import {
  type ReleaseManifest,
  type ReleaseSkillBundle,
} from './postplus-release.js';

import { resolveApiBaseUrlState } from './local-state.js';

const RELEASE_MANIFEST_PATH = '/api/postplus-cli/release-manifest';
const RELEASE_SKILL_PATH_PREFIX = '/api/postplus-cli/release-skills';

type RouteErrorPayload = {
  error?: string;
  code?: string;
};

function normalizeHostedBaseUrl(value: string): string {
  const url = new URL(value.trim());
  const pathname = url.pathname.replace(/\/+$/, '');
  const normalizedPathname =
    pathname.length > 0 && pathname !== '/' ? pathname : '';
  return `${url.origin}${normalizedPathname}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.text();
  const payload =
    raw.trim().length > 0
      ? (JSON.parse(raw) as T | RouteErrorPayload)
      : ({} as T | RouteErrorPayload);

  if (!response.ok) {
    const routeError = payload as RouteErrorPayload;
    const routeMessage =
      typeof routeError.error === 'string'
        ? routeError.error
        : response.statusText;

    throw new Error(
      `Hosted PostPlus request failed (${response.status}): ${routeMessage}`,
    );
  }

  return payload as T;
}

export async function resolveHostedBaseUrl(): Promise<string | null> {
  const state = await resolveApiBaseUrlState();
  return state.value ? normalizeHostedBaseUrl(state.value) : null;
}

export async function requireHostedBaseUrl(): Promise<string> {
  const baseUrl = await resolveHostedBaseUrl();

  if (!baseUrl) {
    throw new Error('Could not resolve a PostPlus API base URL.');
  }

  return baseUrl;
}

export function getHostedReleaseManifestUrl(baseUrl: string): string {
  return `${normalizeHostedBaseUrl(baseUrl)}${RELEASE_MANIFEST_PATH}`;
}

export function getHostedReleaseSkillUrl(
  baseUrl: string,
  skillId: string,
): string {
  return `${normalizeHostedBaseUrl(baseUrl)}${RELEASE_SKILL_PATH_PREFIX}/${encodeURIComponent(skillId)}`;
}

export async function loadHostedReleaseManifest(
  baseUrl: string,
): Promise<ReleaseManifest> {
  return fetchJson<ReleaseManifest>(getHostedReleaseManifestUrl(baseUrl));
}

export async function loadHostedReleaseSkillBundle(
  baseUrl: string,
  skillId: string,
): Promise<ReleaseSkillBundle> {
  return fetchJson<ReleaseSkillBundle>(
    getHostedReleaseSkillUrl(baseUrl, skillId),
  );
}
