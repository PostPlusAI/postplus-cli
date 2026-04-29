import { resolveApiBaseUrlState } from './local-state.js';

function normalizeHostedBaseUrl(value: string): string {
  const url = new URL(value.trim());
  const pathname = url.pathname.replace(/\/+$/, '');
  const normalizedPathname =
    pathname.length > 0 && pathname !== '/' ? pathname : '';
  return `${url.origin}${normalizedPathname}`;
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
