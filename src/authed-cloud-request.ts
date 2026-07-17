import { buildPostPlusClientCompatibilityHeaders } from './client-compatibility.js';
import { fetchWithNetworkDiagnostics } from './network-diagnostics.js';

const DEFAULT_AUTHED_REQUEST_TIMEOUT_MS = 15_000;

export type AuthedCloudRequestAuth = {
  apiBaseUrl: string;
  cliSessionToken: string;
};

export type AuthedCloudRequestInput = {
  auth: AuthedCloudRequestAuth;
  pathName: string;
  method?: 'GET' | 'POST';
  /**
   * Parsed JSON body. When provided the request sends `content-type:
   * application/json` and the serialized body; when omitted neither is sent.
   */
  body?: unknown;
  debug?: boolean;
  skillName?: string | null;
  /**
   * In-process override for the skills release id header. When provided (the
   * hosted-lib path) it is stamped verbatim and the disk config is NOT read for
   * the release id; when omitted (the bin path) the release id comes from
   * `readLocalConfig()` as before.
   */
  skillsReleaseId?: string | null;
  timeoutMs?: number;
  /**
   * Optional once-only 401 refresh. When provided, a `401` response triggers a
   * single retry: `refreshAuth()` returns fresh credentials and the request is
   * re-issued once with them. When omitted, the first response is returned
   * verbatim (the caller keeps its own `!ok` interpretation either way).
   */
  retryOn401?: () => Promise<AuthedCloudRequestAuth>;
};

/**
 * Single transport envelope for every authenticated PostPlus Cloud request:
 * canonical header set (`accept` + compatibility headers + `Bearer` token +
 * optional `content-type`), `AbortSignal.timeout`, and an optional once-only
 * 401-refresh-retry. It returns the raw `Response` so each caller keeps its own
 * `!ok` interpretation — this is a narrow transport primitive, not a request
 * framework.
 */
export async function sendAuthedCloudRequest(
  input: AuthedCloudRequestInput,
): Promise<Response> {
  let response = await issueAuthedCloudRequest(input.auth, input);

  if (response.status === 401 && input.retryOn401) {
    const refreshedAuth = await input.retryOn401();
    response = await issueAuthedCloudRequest(refreshedAuth, input);
  }

  return response;
}

async function issueAuthedCloudRequest(
  auth: AuthedCloudRequestAuth,
  input: AuthedCloudRequestInput,
): Promise<Response> {
  const compatibilityHeaders = await buildPostPlusClientCompatibilityHeaders({
    skillName: input.skillName ?? null,
    ...(input.skillsReleaseId !== undefined
      ? { skillsReleaseId: input.skillsReleaseId }
      : {}),
  });
  const hasBody = input.body !== undefined;
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...compatibilityHeaders,
    authorization: `Bearer ${auth.cliSessionToken}`,
  };

  if (hasBody) {
    headers['content-type'] = 'application/json';
  }

  const requestUrl = new URL(input.pathName, normalizeBaseUrl(auth.apiBaseUrl));

  return fetchWithNetworkDiagnostics(
    requestUrl,
    {
      method: input.method ?? 'GET',
      headers,
      ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
      signal: AbortSignal.timeout(
        input.timeoutMs ?? DEFAULT_AUTHED_REQUEST_TIMEOUT_MS,
      ),
    },
    {
      ...(input.debug !== undefined ? { debug: input.debug } : {}),
      label: 'cloud',
      redirectPolicy: 'error',
    },
  );
}

function normalizeBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
}
