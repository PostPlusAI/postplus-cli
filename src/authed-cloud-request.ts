import { buildPostPlusClientCompatibilityHeaders } from './client-compatibility.js';

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
  skillName?: string | null;
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

  return fetch(requestUrl, {
    method: input.method ?? 'GET',
    headers,
    ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
    signal: AbortSignal.timeout(
      input.timeoutMs ?? DEFAULT_AUTHED_REQUEST_TIMEOUT_MS,
    ),
  });
}

function normalizeBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
}
