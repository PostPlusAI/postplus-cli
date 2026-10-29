import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import crossSpawn from 'cross-spawn';

const checkout = fileURLToPath(new URL('..', import.meta.url));
type Manifest = { name: string; version: string; dependencies?: Record<string, string> };

// This runs the actual npm executable, packed release, updater and bundled Skill
// installer. Only registry distribution and the account's HTTP responses are
// loopback fixtures. No injected module can fabricate an updater success.
test('a real npm package update verifies Skills and continues the same task in one conversation', { timeout: 180_000 }, async (t) => {
  const local = join(checkout, '.local');
  await mkdir(local, { recursive: true });
  const root = await mkdtemp(join(local, 'packaged-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(['home', 'project', 'config', 'prefix', 'cache', 'archives', 'tmp'].map((name) => [name, join(root, name)]));
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(npm_config_|postplus_)/i.test(key) && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
  Object.assign(env, {
    HOME: paths.home, USERPROFILE: paths.home, TMPDIR: paths.tmp, TMP: paths.tmp, TEMP: paths.tmp,
    XDG_CONFIG_HOME: join(paths.home!, '.config'), XDG_STATE_HOME: join(paths.home!, '.state'),
    CODEX_HOME: join(paths.home!, '.codex'), CLAUDE_CONFIG_DIR: join(paths.home!, '.claude'),
    VIBE_HOME: join(paths.home!, '.vibe'), HERMES_HOME: join(paths.home!, '.hermes'),
    AUTOHAND_HOME: join(paths.home!, '.autohand'), GROK_HOME: join(paths.home!, '.grok'),
    SARVAM_HOME: join(paths.home!, '.sarvam'), APPDATA: join(paths.home!, '.appdata'),
    FLATPAK_XDG_CONFIG_HOME: join(paths.home!, '.flatpak'),
    POSTPLUS_CONFIG_DIR: paths.config,
    npm_config_prefix: paths.prefix, npm_config_cache: paths.cache,
    npm_config_userconfig: join(root, 'npmrc'), npm_config_globalconfig: join(root, 'global-npmrc'),
    npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_update_notifier: 'false', npm_config_fetch_retries: '0',
    DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  });
  await Promise.all(['npmrc', 'global-npmrc'].map((name) => writeFile(join(root, name), '')));
  const run = (command: string, args: string[], cwd = paths.project!) => new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = crossSpawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
    let stdout = '', stderr = '';
    child.stdout!.on('data', (chunk) => { stdout += chunk; });
    child.stderr!.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? accept({ stdout, stderr }) : reject(new Error(
      `${command} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`,
    )));
  });

  const packages: Array<{ manifest: Manifest; bytes: Buffer; archive: string; files: Array<{ path: string }> }> = [];
  const visited = new Set<string>();
  async function pack(directory: string): Promise<void> {
    const manifestPath = await realpath(join(directory, 'package.json'));
    if (visited.has(manifestPath)) return;
    visited.add(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
    const { stdout } = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', paths.archives!], directory);
    const [report] = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const archive = join(paths.archives!, report!.filename);
    packages.push({ manifest, archive, bytes: await readFile(archive), files: report!.files });
    const require = createRequire(manifestPath);
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      await pack(dirname(await realpath(require.resolve(`${name}/package.json`))));
    }
  }
  // npm pack uses existing installed dependencies only; it never installs them.
  // The loopback registry serves their real packed dependency closure to npm.
  env.npm_config_registry = 'http://127.0.0.1:1/';
  await pack(checkout);
  const candidate = packages[0]!;
  const manifest = JSON.parse(await readFile(join(checkout, 'bundled-skills/skills-manifest.json'), 'utf8'));
  const requests: Array<{ method: string; path: string; version: string | undefined; skills: string | undefined; status: number }> = [];
  const registryRequests: string[] = [];
  const unexpected: string[] = [];
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname);
    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (path === '/api/postplus-cli/channels') {
      const version = request.headers['x-postplus-cli-version'] as string | undefined;
      const skills = request.headers['x-postplus-skills-release-id'] as string | undefined;
      const status = version === candidate.manifest.version && skills === manifest.releaseId ? 200 : 426;
      requests.push({ method: request.method!, path, version, skills, status });
      if (status === 426) return json(status, {
        code: 'postplus_client_upgrade_required',
        compatibility: {
          reason: 'cli_release_too_old', received: { cliVersion: version, skillsReleaseId: skills ?? null },
          required: { cliVersion: candidate.manifest.version, skillsReleaseId: manifest.releaseId },
          upgrade: { cli: { required: true }, skills: { required: true }, restartAgentSession: true },
        },
      });
      return json(200, { marker: 'original-task-completed', channels: [] });
    }
    registryRequests.push(path);
    const archiveIndex = /^\/archives\/(\d+)\.tgz$/.exec(path)?.[1];
    const packed = archiveIndex === undefined ? undefined : packages[Number(archiveIndex)];
    if (packed) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': packed.bytes.length });
      return response.end(packed.bytes);
    }
    const matching = packages.filter((item) => path === `/${item.manifest.name}`);
    if (matching.length > 0) return json(200, {
      name: matching[0]!.manifest.name,
      'dist-tags': { latest: matching[0]!.manifest.version },
      versions: Object.fromEntries(matching.map((item) => [item.manifest.version, {
        ...item.manifest,
        dist: {
          tarball: `${env.npm_config_registry}archives/${packages.indexOf(item)}.tgz`,
          integrity: `sha512-${createHash('sha512').update(item.bytes).digest('base64')}`,
          shasum: createHash('sha1').update(item.bytes).digest('hex'),
        },
      }])),
    });
    unexpected.push(`${request.method} ${path}`);
    json(404, { error: 'No external registry fallback is allowed in this test.' });
  });
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((accept) => server.close(() => accept())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  env.npm_config_registry = `${origin}/`;
  env.POSTPLUS_API_BASE_URL = origin;
  await writeFile(join(paths.config!, 'config.json'), JSON.stringify({
    apiBaseUrl: origin, sessionApiBaseUrl: origin, cliSessionToken: 'offline-fixture-token',
    sessionExpiresAt: null, userId: 'fixture-user', accountId: 'fixture-account',
  }), { mode: 0o600 });

  await run('npm', ['install', '-g', candidate.archive]);
  const npmRoot = (await run('npm', ['root', '-g'])).stdout.trim();
  const installed = join(npmRoot, '@postplus/cli');
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  // Only installed version metadata is old; the executable is the real candidate.
  // This tests the package replacement/recovery mechanism, not historical ABI migration.
  await writeFile(join(installed, 'package.json'), JSON.stringify({ ...metadata, version: '0.0.0' }));
  env.npm_config_cache = join(root, 'recovery-cache');
  registryRequests.length = 0;
  const result = await run(process.execPath, [join(installed, 'build/index.js'), 'channels', 'list', '--json']);
  assert.deepEqual(JSON.parse(result.stdout), { marker: 'original-task-completed', channels: [] });
  assert.match(result.stderr, /Read the updated Skill/);
  assert.match(result.stderr, /continue the original task in this conversation/);
  assert.doesNotMatch(result.stderr, /Start a new agent session|npm installation finished/);
  assert.deepEqual(requests, [
    { method: 'GET', path: '/api/postplus-cli/channels', version: '0.0.0', skills: undefined, status: 426 },
    { method: 'GET', path: '/api/postplus-cli/channels', version: candidate.manifest.version, skills: manifest.releaseId, status: 200 },
  ]);
  assert.deepEqual(unexpected, []);
  assert.equal(registryRequests.filter((path) => path === '/archives/0.tgz').length, 1, 'one real package replacement');
  const logs = await readdir(join(env.npm_config_cache!, '_logs'));
  const logTexts = await Promise.all(logs.map((name) => readFile(join(env.npm_config_cache!, '_logs', name), 'utf8')));
  assert.equal(logTexts.filter((text) => text.includes(`verbose title npm install @postplus/cli@${candidate.manifest.version}`)).length, 1,
    'exactly one real npm install, without an updater stub');
  assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, candidate.manifest.version);
  for (const file of candidate.files.filter((file) => file.path !== 'package.json')) {
    assert.deepEqual(await readFile(join(installed, file.path)), await readFile(join(checkout, file.path)), file.path);
  }
  const verified = JSON.parse((await run(process.execPath, [join(installed, 'build/index.js'), 'skills', 'verify', '--json'])).stdout);
  assert.equal(verified.ok, true);
  assert.equal(verified.verifiedSkillsReleaseId, manifest.releaseId);
  t.diagnostic(`fixture HTTP only; real npm install=1; command requests=2 (426→200); accepted=1; Skills=${verified.requiredCount}; packed files=${candidate.files.length}; paid calls=0`);
});
