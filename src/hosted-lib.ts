// In-process hosted-execution library entry. This is the trusted-runtime
// counterpart to the `postplus` bin: a host process (e.g. eve-agent) that already
// holds the account's fresh session auth can run the SAME hosted verb grammar
// in-process — resolve verb -> build the typed envelope -> POST -> return the
// parsed payload — WITHOUT spawning a CLI subprocess, reading disk config, or
// writing any temp/output file.
//
// Why this exists (anti-drift): the bin path and this lib path share ONE
// resolve+build+post core in hosted-domain-commands.ts. For the same
// domain+args+input+auth they produce a byte-identical hosted HTTP request (URL +
// JSON body + headers). The only divergence is the input source and the result
// sink, both injected via HostedRequestContext: auth + skillsReleaseId come in as
// parameters (no `resolveFreshRemoteAuth()` disk read, no 401-refresh-retry — the
// host supplies fresh session auth each turn), the request-json body comes from
// `requestJson` instead of a `--request <file>`, and the parsed payload is RETURNED
// (the structured HostedProductRequestError / quote-confirmation error are thrown
// verbatim) instead of being written to stdout/file with an exit code.
//
// Scope: only the hosted spend/write surfaces go through here —
// media / research / publish / media-file. Read-only diagnostics (status / doctor
// / skills / whoami / quote / list / --version / --help) are NOT hosted-domain
// commands and are out of scope for this entry.

import type { AuthedCloudRequestAuth } from './authed-cloud-request.js';
import {
  type HostedRequestContext,
  postHostedCapabilityEnvelope,
  runHostedDomainCommand,
  runMediaFileCommand,
} from './hosted-domain-commands.js';

export type HostedLibDomain = 'media' | 'research' | 'publish' | 'media-file';

export type RunHostedRequestInput = {
  /** Which hosted verb family `args` belongs to (the first CLI token). */
  domain: HostedLibDomain;
  /**
   * The CLI tokens AFTER the domain, exactly as the bin would receive them, e.g.
   * `['create', 'video-seedance-2-text']` or `['collect', 'tiktok-research']`.
   * Flags surfaces still pass their `--flag value` tokens here; request-json
   * surfaces pass the body via `requestJson` instead of a `--request <file>`.
   */
  args: string[];
  /**
   * The request-json envelope for request-json surfaces, injected in place of a
   * `--request <file>` read. Omit it for flags surfaces (media create/transcribe
   * flag-driven) and for surfaces that need no body (polling/run-handle).
   */
  requestJson?: Record<string, unknown> | unknown[];
  /** The account's fresh session auth, supplied by the trusted host runtime. */
  auth: AuthedCloudRequestAuth;
  /**
   * The skills release id stamped into `x-postplus-skills-release-id`. Provided
   * verbatim by the host (it is NOT read from disk on this path).
   */
  skillsReleaseId?: string;
};

/**
 * Runs a hosted media / research / publish / media-file request in-process and
 * returns the parsed hosted payload. Throws the structured
 * HostedProductRequestError / quote-confirmation error VERBATIM on failure — no
 * stdout, no file writes, no exit code. The wire request is identical to the bin
 * path for the same input (proven by the parity test).
 */
export async function runHostedRequest(
  input: RunHostedRequestInput,
): Promise<unknown> {
  const context: HostedRequestContext = {
    auth: input.auth,
    ...(input.skillsReleaseId !== undefined
      ? { skillsReleaseId: input.skillsReleaseId }
      : {}),
    ...(input.requestJson !== undefined
      ? { requestJson: input.requestJson }
      : {}),
  };

  if (input.domain === 'media-file') {
    return runMediaFileCommand(input.args, context);
  }

  return runHostedDomainCommand(input.domain, input.args, context);
}

export type RunHostedCapabilityEnvelopeInput = {
  /**
   * The raw `/api/postplus-cli/hosted/capability` request body (capability,
   * operation, operationId, verb fields). The Web boundary owns validation —
   * this entry is a pure transport for verb families with no CLI grammar
   * (e.g. the internal `workflow` verbs the eve-agent workspace tools drive).
   */
  body: Record<string, unknown>;
  /** The account's fresh session auth, supplied by the trusted host runtime. */
  auth: AuthedCloudRequestAuth;
  /** The skills release id stamped into `x-postplus-skills-release-id`. */
  skillsReleaseId?: string;
};

/**
 * Posts a hosted capability envelope in-process and returns the parsed payload.
 * Shares `postHostedJson` with every bin verb, so headers and the structured
 * HostedProductRequestError / quote-confirmation error behavior are identical.
 */
export async function runHostedCapabilityEnvelope(
  input: RunHostedCapabilityEnvelopeInput,
): Promise<unknown> {
  return postHostedCapabilityEnvelope({
    body: input.body,
    context: {
      auth: input.auth,
      ...(input.skillsReleaseId !== undefined
        ? { skillsReleaseId: input.skillsReleaseId }
        : {}),
    },
  });
}
