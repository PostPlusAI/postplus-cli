import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const TAR_EXECUTABLE = process.platform === 'win32'
  ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
export const RELEASE_URL = 'https://postplus.io/postplus-runtime.json';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function validateArtifact(artifact) {
  if (!artifact || typeof artifact.url !== 'string' || !SHA256.test(artifact.sha256) ||
      typeof artifact.directory !== 'string' || !/^[A-Za-z0-9._-]+$/.test(artifact.directory) ||
      artifact.directory === '.' || artifact.directory === '..') throw new Error('Invalid PostPlus release artifact.');
  const url = new URL(artifact.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('PostPlus artifacts require an authenticated HTTPS origin.');
  return artifact;
}

export function validateRelease(release) {
  if (!release || release.schemaVersion !== 1 || !VERSION.test(release.cliVersion) ||
      typeof release.releaseId !== 'string' || !release.releaseId.trim() ||
      typeof release.skillsReleaseId !== 'string' || !release.skillsReleaseId.trim() ||
      !VERSION.test(release.node?.version) || !release.node.artifacts || typeof release.node.artifacts !== 'object') {
    throw new Error('Invalid PostPlus managed release. No installation was changed.');
  }
  validateArtifact(release.cli);
  for (const [platform, artifact] of Object.entries(release.node.artifacts)) {
    if (!/^(darwin|linux|win32)-(arm64|x64)$/.test(platform)) throw new Error('Unknown Node distribution platform.');
    validateArtifact(artifact);
  }
  return release;
}

export function selectNodeArtifact(release, platform = process.platform, arch = process.arch) {
  validateRelease(release);
  const artifact = release.node.artifacts[`${platform}-${arch}`];
  if (!artifact) throw new Error(`PostPlus does not yet provide its runtime for ${platform}/${arch}.`);
  return artifact;
}

// Add operation evidence without reclassifying an existing transport/OS error.
// Serialization and redaction remain owned by the CLI failure contract.
export function runtimeFailure(cause, context) {
  if (cause?.component || cause?.details?.component) return cause;
  const error = new Error(cause instanceof Error ? cause.message : 'PostPlus runtime operation failed.', { cause });
  Object.assign(error, {
    code: typeof cause?.code === 'string' ? cause.code : 'postplus_runtime_operation_failed',
    service: cause?.service ?? cause?.details?.service ?? 'managed-runtime', retryable: cause?.retryable ?? cause?.details?.retryable ?? false,
    action: cause?.action ?? cause?.details?.action ?? 'Resolve the reported runtime operation failure, then run postplus update.',
    currentVersion: 'unknown', targetVersion: context.version ?? 'unknown',
    ...context,
  });
  return error;
}

export async function fetchRelease(fetchFn, url = RELEASE_URL, context = {}) {
  const started = performance.now();
  const timeoutMs = 30_000;
  let stage = 'release-request';
  let response;
  try {
    const location = new URL(url);
    if (location.protocol !== 'https:' || location.username || location.password) throw new Error('PostPlus release metadata requires HTTPS.');
    response = await fetchFn(location, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`PostPlus release information could not be downloaded (HTTP ${response.status}).`);
    }
    stage = 'release-body';
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 128 * 1024) throw new Error('PostPlus release metadata is too large.');
      chunks.push(Buffer.from(chunk));
    }
    stage = 'release-validation';
    return validateRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (cause) {
    throw runtimeFailure(cause, { component: 'release-metadata', stage, operation: context.operation ?? 'fetch-release',
      platform: `${process.platform}-${process.arch}`, originalUrl: String(url), failureUrl: String(url),
      elapsedMs: Math.round(performance.now() - started), timeoutMs,
      ...(response ? { httpStatus: response.status } : {}) });
  }
}

export async function downloadArtifact(artifact, destination, fetchFn, context = {}) {
  const started = performance.now();
  const timeoutMs = 300_000;
  let stage = 'artifact-validation';
  let url = artifact.url;
  let response;
  try {
    validateArtifact(artifact);
    // HTTPS redirects and the existing hop/timeout bounds remain unchanged.
    stage = 'artifact-request';
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      stage = 'artifact-redirect';
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next || redirects === 5) throw new Error('PostPlus artifact redirect limit or location is invalid.');
      const resolved = new URL(next, url);
      url = resolved.href;
      if (resolved.protocol !== 'https:' || resolved.username || resolved.password) throw new Error('PostPlus artifact redirect must remain HTTPS.');
      response = undefined;
      stage = 'artifact-request';
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`PostPlus artifact download failed (HTTP ${response.status}).`);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const measure = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > 512 * 1024 * 1024) return callback(new Error('PostPlus artifact exceeds the download limit.'));
      hash.update(chunk); callback(null, chunk);
    } });
    let file;
    stage = 'artifact-write';
    try { file = await open(destination, 'wx', 0o600); }
    catch (error) { await response.body.cancel(); throw error; }
    try {
      stage = 'artifact-body';
      await pipeline(Readable.fromWeb(response.body), measure, file.createWriteStream());
      stage = 'artifact-checksum';
      if (hash.digest('hex') !== artifact.sha256) throw new Error('PostPlus download checksum does not match the approved release.');
      return destination;
    } catch (error) { await file.close(); await rm(destination, { force: true }); throw error; }
    finally { await file.close(); }
  } catch (cause) {
    throw runtimeFailure(cause, { component: 'artifact', ...context, stage, operation: context.operation ?? 'download-artifact',
      platform: `${process.platform}-${process.arch}`, originalUrl: artifact.url, failureUrl: url,
      elapsedMs: Math.round(performance.now() - started), timeoutMs,
      ...(response ? { httpStatus: response.status } : {}) });
  }
}

export async function extractArtifact(archive, artifact, destination, context = {}) {
  const started = performance.now();
  try {
    // Called only after verifying the approved archive digest.
    await mkdir(destination, { recursive: true });
    await exec(TAR_EXECUTABLE, [new URL(artifact.url).pathname.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', destination], { timeout: 120_000 });
    return join(destination, artifact.directory);
  } catch (cause) {
    throw runtimeFailure(cause, { component: 'artifact', ...context, stage: 'artifact-extract', operation: context.operation ?? 'extract-artifact',
      platform: `${process.platform}-${process.arch}`, originalUrl: artifact.url,
      elapsedMs: Math.round(performance.now() - started), timeoutMs: 120_000 });
  }
}
