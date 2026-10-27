import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  PostPlusFailure,
  formatFailure,
  toFailureFact,
  withResponseMetadata,
} from "./failure-contract.js";
import { PostPlusNetworkRequestError } from "./network-diagnostics.js";
import { readPostPlusCompatibilityError } from "./client-compatibility.js";

const exec = promisify(execFile);
test("failure diagnostics retain bounded causes and redact credentials", () => {
  const cause = Object.assign(
    new Error(
      "connect token=private Bearer secret https://user:pass@host/a?sig=secret",
    ),
    { code: "ENOTFOUND" },
  );
  cause.cause = cause;
  const error = new PostPlusNetworkRequestError({
    cause,
    method: "POST",
    targetUrl: "https://postplus.io/api",
  });
  const failure = toFailureFact(error);
  assert.equal(failure.service, "postplus-cloud");
  assert.equal(failure.correlationId, null);
  assert.equal(failure.cause[1].code, "ENOTFOUND");
  assert.equal(failure.cause.length, 2);
  assert.doesNotMatch(
    JSON.stringify(failure),
    /private|Bearer secret|user:pass|sig=secret/,
  );
  assert.match(formatFailure(failure), /ENOTFOUND/);
  assert.match(formatFailure(failure), /service=postplus-cloud/);
  assert.doesNotMatch(failure.action, /retry the command/);
});

test("compatibility separates upgrade, cloud release and transport failures", () => {
  const upgrade = readPostPlusCompatibilityError({
    code: "postplus_client_upgrade_required",
  })!;
  const releasing = readPostPlusCompatibilityError({
    code: "postplus_cli_cloud_release_in_progress",
  })!;
  const response = new Response("{}", {
    status: 503,
    headers: { "x-request-id": "server-request-123" },
  });
  const failure = toFailureFact(withResponseMetadata(releasing, response));
  assert.equal(toFailureFact(upgrade).code, "postplus_client_upgrade_required");
  assert.equal(failure.code, "postplus_cli_cloud_release_in_progress");
  assert.equal(failure.retryable, true);
  assert.equal(failure.correlationId, "server-request-123");
  assert.equal(failure.httpStatus, 503);
});

test("media failure keeps resume identity and its specific next action", () => {
  const error = Object.assign(new Error("verbose low level detail"), {
    code: "idle_timeout",
    stage: "stream-bytes",
    retryable: true,
    checkpointId: "original",
    resumeAvailable: true,
    userAction: "Resume the same download.",
  });
  const fact = toFailureFact(error);
  assert.equal(fact.checkpointId, "original");
  assert.equal(fact.resumeAvailable, true);
  assert.equal(fact.action, "Resume the same download.");
});

async function cli(args: string[], config: string) {
  try {
    return {
      ...(await exec(
        process.execPath,
        ['build/index.js', ...args],
        { env: { ...process.env, POSTPLUS_CONFIG_DIR: config } },
      )),
      code: 0,
    };
  } catch (error) {
    return error as unknown as { stdout: string; stderr: string; code: number };
  }
}
test("compiled CLI emits JSON for parse and pre-command config failures", async () => {
  const config = await mkdtemp(join(tmpdir(), "postplus-failure-"));
  try {
    const parsed = await cli(["install", "--unknown", "--json"], config);
    assert.equal(parsed.code, 1);
    assert.equal(parsed.stderr, "");
    assert.equal(JSON.parse(parsed.stdout).error.stage, "install");
    await writeFile(join(config, "config.json"), "{broken", { mode: 0o600 });
    const corrupt = await cli(["status", "--json"], config);
    assert.equal(corrupt.code, 1);
    assert.equal(JSON.parse(corrupt.stdout).ok, false);
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});

test("mutation help is local and accepts JSON without installing", async () => {
  const config = await mkdtemp(join(tmpdir(), "postplus-help-"));
  try {
    for (const command of ["install", "update", "uninstall"]) {
      const result = await cli([command, "--help", "--json"], config);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).command, `postplus ${command}`);
      assert.equal('--yes' in JSON.parse(result.stdout).options, false);
    }
  } finally {
    await rm(config, { recursive: true, force: true });
  }
});

test("central transport preserves caller-owned redirect rejection and request body", async (t) => {
  const { diagnosticFetch } = await import("./network-diagnostics.js");
  const original = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(init!);
    return new Response(null, {
      status: 307,
      headers: { location: "https://untrusted.example/next" },
    });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const signal = new AbortController().signal;
  const response = await diagnosticFetch("http://localhost/auth", {
    method: "POST",
    body: "secret",
    redirect: "manual",
    signal,
  });
  assert.equal(response.status, 307);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[0].body, "secret");
  await assert.rejects(
    diagnosticFetch("http://localhost/upload", {
      body: "bytes",
      method: "PUT",
    }),
    /Unexpected HTTP 307 redirect/,
  );
  assert.equal(
    calls.length,
    2,
    "never forwarded a signed upload or credential",
  );
});

test('compatibility identifies old CLI, old skills, and missing local skill record', () => {
  const samples = [
    { reason: 'cli_release_too_old', received: { cliVersion: '0.1.0', skillsReleaseId: 'skills-old' }, upgrade: { cli: { required: true } } },
    { reason: 'skills_release_mismatch', received: { cliVersion: '0.2.10', skillsReleaseId: 'skills-old' }, upgrade: { skills: { required: true } } },
    { reason: 'skills_release_mismatch', received: { cliVersion: '0.2.10', skillsReleaseId: null }, upgrade: { skills: { required: true } } },
  ];
  const facts = samples.map((compatibility) => toFailureFact(readPostPlusCompatibilityError({ code: 'postplus_client_upgrade_required', compatibility })));
  assert.deepEqual(facts.map((fact) => fact.compatibilityReason), ['cli_release_too_old', 'skills_release_mismatch', 'skills_baseline_missing']);
  assert.equal(new Set(facts.map((fact) => fact.message)).size, 3);
  assert.ok(facts.every((fact) => fact.action.startsWith('Run postplus update. After a successful update,')));
  assert.equal(facts[2]?.versions?.skillsReleaseId, null);
});

test('diagnostics redact complete cookies and password values', () => {
  const fact = toFailureFact(new Error('password=hunter2\nCookie: session=abc; other=secretvalue'));
  assert.doesNotMatch(JSON.stringify(fact), /hunter2|secretvalue|session=abc/);
});

test('runtime facts preserve inherited error codes and share sanitized machine and human evidence', () => {
  class InheritedCode extends Error { get code() { return 'ENOTFOUND'; } }
  const original = new InheritedCode('lookup failed at /Users/private-person/cache token=private');
  const error = Object.assign(original, { component: 'node', operation: 'download-artifact', stage: 'artifact-request',
    version: '24.21.0', platform: 'darwin-arm64', originalUrl: 'https://user:password@nodejs.org/dist/node.tar.gz?token=private#private',
    failureUrl: 'https://cdn.test/node.tar.gz?sig=private', httpStatus: 503, elapsedMs: 125, timeoutMs: 300000 });
  const fact = toFailureFact(error);
  assert.equal(fact.code, 'ENOTFOUND');
  assert.equal(fact.originalUrl, 'https://nodejs.org/dist/node.tar.gz?[redacted]');
  assert.equal(fact.failureUrl, 'https://cdn.test/node.tar.gz?[redacted]');
  const human = formatFailure(fact);
  for (const value of ['node', 'download-artifact', 'artifact-request', '24.21.0', 'darwin-arm64', '503', '125', '300000', 'ENOTFOUND', fact.originalUrl!, fact.failureUrl!]) assert.ok(human.includes(value));
  assert.doesNotMatch(JSON.stringify(fact) + human, /private-person|token=private|sig=private|user:password/);
});


test('child failure envelopes fail closed when required fields are missing or malformed', async () => {
  const { readFailureOutput } = await import('./failure-contract.js');
  const error = { code: 'failed', stage: 'artifact-request', service: 'network', message: 'download failed',
    action: 'Resolve the failure.', retryable: false, cause: [] };
  assert.ok(readFailureOutput(JSON.stringify({ok:false,error})));
  for (const key of ['stage', 'service', 'action', 'retryable', 'cause']) {
    const missing: Record<string, unknown> = {...error};
    delete missing[key];
    assert.equal(readFailureOutput(JSON.stringify({ok:false,error:missing})), undefined, key);
  }
  assert.equal(readFailureOutput(JSON.stringify({ok:false,error:{...error,cause:'unexpected'}})), undefined);
  assert.equal(readFailureOutput(JSON.stringify({ok:false,error:{...error,retryable:'true'}})), undefined);
});

test('ordinary transport diagnostics distinguish known DNS TLS timeout and unknown causes', () => {
  for (const [code, message] of [['ENOTFOUND', 'DNS lookup failed'], ['CERT_HAS_EXPIRED', 'certificate expired'], ['ETIMEDOUT', 'connection timed out'], [undefined, 'unknown transport error']] as const) {
    const cause = Object.assign(new Error(message), code ? { code } : {});
    const error = new PostPlusNetworkRequestError({ cause, method: 'POST', targetUrl: 'https://postplus.test/api?secret=private' });
    const fact = toFailureFact(error);
    const human = formatFailure(fact);
    assert.ok(human.includes(message));
    if (code) assert.ok(human.includes(code));
    else assert.doesNotMatch(human, /ENOTFOUND|CERT_HAS_EXPIRED|ETIMEDOUT/);
    assert.equal(fact.retryable, code !== 'CERT_HAS_EXPIRED');
    assert.equal(fact.correlationId, null);
    assert.doesNotMatch(human + JSON.stringify(fact), /secret=private/);
  }
});
