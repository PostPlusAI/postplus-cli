import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
const exec = promisify(execFile);
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

export async function fetchRelease(fetchFn, url = RELEASE_URL) {
  const location = new URL(url);
  if (location.protocol !== 'https:' || location.username || location.password) throw new Error('PostPlus release metadata requires HTTPS.');
  const response = await fetchFn(location, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`PostPlus release information could not be downloaded (HTTP ${response.status}).`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 128 * 1024) throw new Error('PostPlus release metadata is too large.');
    chunks.push(Buffer.from(chunk));
  }
  return validateRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export async function downloadArtifact(artifact, destination, fetchFn) {
  validateArtifact(artifact);
  // Follow only HTTPS redirects with a fixed hop bound. GitHub release downloads
  // redirect to their asset CDN; a redirect never authorizes plaintext HTTP.
  let url = artifact.url;
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetchFn(url, { signal: AbortSignal.timeout(300_000), redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = response.headers.get('location');
    await response.body?.cancel();
    if (!next || redirects === 5) throw new Error('PostPlus artifact redirect limit or location is invalid.');
    const resolved = new URL(next, url);
    if (resolved.protocol !== 'https:' || resolved.username || resolved.password) throw new Error('PostPlus artifact redirect must remain HTTPS.');
    url = resolved.href;
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
  // Acquire exclusive ownership before cleanup is allowed to remove this path.
  let file;
  try { file = await open(destination, 'wx', 0o600); }
  catch (error) { await response.body.cancel(); throw error; }
  try {
    await pipeline(Readable.fromWeb(response.body), measure, file.createWriteStream());
    if (hash.digest('hex') !== artifact.sha256) throw new Error('PostPlus download checksum does not match the approved release.');
    return destination;
  } catch (error) { await file.close(); await rm(destination, { force: true }); throw error; }
  finally { await file.close(); }
}

export async function extractArtifact(archive, artifact, destination) {
  // This is called only after verifying the exact approved archive digest.
  await mkdir(destination, { recursive: true });
  if (new URL(artifact.url).pathname.endsWith('.zip')) {
    await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:POSTPLUS_ARCHIVE -DestinationPath $env:POSTPLUS_EXTRACT -ErrorAction Stop'],
    { env: { ...process.env, POSTPLUS_ARCHIVE: archive, POSTPLUS_EXTRACT: destination }, timeout: 120_000 });
  } else {
    await exec('tar', ['-xzf', archive, '-C', destination], { timeout: 120_000 });
  }
  return join(destination, artifact.directory);
}
