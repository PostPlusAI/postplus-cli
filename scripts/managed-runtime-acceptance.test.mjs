import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { writeBootstrapScripts } from './build-runtime-installers.mjs';
const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('official bootstrap installs and reuses a complete managed runtime without system Node', { timeout: 240000 }, async t => {
  let server;
  const sockets = new Set();
  try {
  const windows = process.platform === 'win32';
  const archive = process.env.POSTPLUS_TEST_NODE_ARCHIVE;
  assert.ok(archive, 'POSTPLUS_TEST_NODE_ARCHIVE must name the pinned official Node archive');
  const release = JSON.parse(await readFile(join(repo, 'dist/postplus-runtime.json'), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'postplus bootstrap space '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const project = join(root, 'project'); const program = join(home, 'program');
  const config = join(home, 'config'); const dist = join(root, 'dist');
  for (const path of [home, project, config, dist]) await mkdir(path, { recursive: true });
  const existingConfig = { apiBaseUrl: 'https://postplus.io', userId: 'fixture-user', userEmail: 'migration-fixture@example.invalid' };
  await writeFile(join(config, 'config.json'), JSON.stringify(existingConfig), { mode: 0o600 });
  const key = join(root, 'key.pem'); const cert = join(root, 'cert.pem');
  const opensslConfig = join(root, 'openssl.cnf');
  await writeFile(opensslConfig, '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=localhost\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-config', opensslConfig]);
  const downloads = { node: 0, cli: 0 };
  server = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    const name = request.url === (windows ? '/node.zip' : '/node.tar.gz') ? 'node' : request.url === '/cli.tar.gz' ? 'cli' : null;
    if (!name) { response.writeHead(404); response.end(); return; }
    downloads[name]++;
    process.stderr.write('Acceptance download started: ' + name + '\n');
    response.on('finish', () => process.stderr.write('Acceptance download completed: ' + name + '\n'));
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    createReadStream(name === 'node' ? archive : join(repo, `dist/postplus-cli-v${release.cliVersion}.tar.gz`)).pipe(response);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  server.unref();
  server.on('connection', socket => { socket.unref(); sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', error => process.stderr.write('Acceptance TLS: ' + error.message + '\n'));
  const base = `https://127.0.0.1:${server.address().port}`;
  release.cli.url = `${base}/cli.tar.gz`;
  release.node.artifacts[`${process.platform}-${process.arch}`].url = `${base}/${windows ? 'node.zip' : 'node.tar.gz'}`;
  await writeBootstrapScripts(root, release);
  // Remove Node from PATH without deleting Windows' executable-extension
  // contract. PowerShell needs PATHEXT to invoke .exe files as native commands.
  const environment = { ...(windows ? { SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT, TEMP: root, TMP: root, LOCALAPPDATA: join(home, 'AppData/Local'), APPDATA: join(home, 'AppData/Roaming') } : {}),
    PATH: windows ? [join(process.env.SystemRoot, 'System32'), join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0')].join(';') : '/usr/bin:/bin', HOME: home, USERPROFILE: home,
    POSTPLUS_CONFIG_DIR: config, POSTPLUS_INSTALL_ROOT: program, XDG_CONFIG_HOME: join(home, '.config'),
    CURL_CA_BUNDLE: cert, NODE_EXTRA_CA_CERTS: cert, DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
  await assert.rejects(windows ? exec('where.exe', ['node'], { env: environment }) : exec('/bin/sh', ['-c', 'command -v node'], { env: environment }), 'test environment must not resolve a system Node');
  if (windows) process.stderr.write((await exec(join(process.env.SystemRoot, 'System32/curl.exe'), ['--version'], { env: environment, timeout: 10000 })).stdout);
  const invoke = (repair = false) => exec(windows ? 'powershell.exe' : '/bin/sh', windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dist, 'install.ps1'), ...(repair ? ['-Repair'] : [])] : [join(dist, 'install.sh'), ...(repair ? ['--repair'] : [])], { cwd: project, env: environment, timeout: 120000, maxBuffer: 1024 * 1024 });
  process.stderr.write('Managed acceptance: first installation\n');
  const first = await invoke(); const installed = JSON.parse(first.stdout);
  assert.equal(installed.ok, true); assert.equal(installed.diskReady, true);
  assert.equal(installed.installation.managed, true); assert.equal(installed.installation.reusedRuntime, false);
  assert.equal(installed.installation.nodeVersion, release.node.version);
  assert.deepEqual(downloads, { node: 1, cli: 1 });
  const launcher = installed.installation.commandPath;
  const launch = args => windows
    ? exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher.replace(/\.cmd$/, '.ps1'), ...args], { cwd: project, env: environment })
    : exec(launcher, args, { cwd: project, env: environment });
  const version = await launch(['--version']);
  assert.equal(version.stdout.trim(), release.cliVersion);
  const verified = JSON.parse((await launch(['skills', 'verify', '--json'])).stdout);
  assert.equal(verified.ok, true); assert.equal(verified.verifiedSkillsReleaseId, release.skillsReleaseId);
  process.stderr.write('Managed acceptance: repeat installation\n');
  const second = JSON.parse((await invoke()).stdout);
  assert.equal(second.ok, true); assert.equal(second.outcome, 'current');
  assert.equal(second.installation.reusedRuntime, true); assert.equal(downloads.node, 1);
  const active = (await readFile(join(program, 'active'), 'utf8')).split('\n');
  const managedNode = join(program, active[3]);
  const managedCli = join(program, active[4]);
  const updateDriver = join(root, 'update-driver.mjs');
  await writeFile(updateDriver, `
    import { pathToFileURL } from 'node:url';
    const { updateManagedInstallation } = await import(pathToFileURL(${JSON.stringify(join(program, active[4], '..', 'managed-runtime.js'))}).href);
    const release = ${JSON.stringify(release)};
    const result = await updateManagedInstallation({ environment: process.env,
      continuationArgs: ['--json'], currentCliEntryPath: ${JSON.stringify(managedCli)},
      fetchFn: (url, options) => String(url) === 'https://postplus.io/postplus-runtime.json'
        ? Promise.resolve(Response.json(release)) : fetch(url, options),
    });
    if (result.exitCode !== 0 || result.latestVersion !== release.cliVersion) process.exitCode = 1;
  `);
  process.stderr.write('Managed acceptance: managed update\n');
  const updated = JSON.parse((await exec(managedNode, [updateDriver], { cwd: project, env: environment, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout);
  assert.equal(updated.ok, true);
  assert.equal(updated.outcome, 'current');
  assert.equal(updated.releaseId, release.skillsReleaseId);
  assert.equal(updated.diskReady, true);
  assert.equal(downloads.node, 1, 'managed update reuses the verified private Node');
  assert.equal(downloads.cli, 2, 'managed update reuses the verified program artifact');
  if (!windows) {
    const shell = await exec('/bin/sh', ['-c', '. "$HOME/.profile"; command -v postplus'], { env: environment });
    assert.equal(shell.stdout.trim(), launcher, 'new shells choose the managed command');
  }
  process.stderr.write('Managed acceptance: explicit runtime repair\n');
  await writeFile(managedNode, 'deliberately damaged test runtime');
  const repaired = JSON.parse((await invoke(true)).stdout);
  assert.equal(repaired.ok, true);
  assert.ok(repaired.installation.repairs.some(item => item.component === 'runtime'));
  const repairedActive = (await readFile(join(program, 'active'), 'utf8')).split('\n');
  assert.notEqual(repairedActive[3], active[3], 'repair selects a fresh immutable runtime directory');
  assert.equal(await readFile(managedNode, 'utf8'), 'deliberately damaged test runtime', 'repair leaves the previous generation untouched');
  assert.equal((await launch(['--version'])).stdout.trim(), release.cliVersion);
  assert.equal(JSON.parse((await invoke()).stdout).installation.reusedRuntime, true);
  assert.equal(downloads.node, 2, 'the repaired private runtime is reused by subsequent installation');
  const saved = JSON.parse(await readFile(join(config, 'config.json'), 'utf8'));
  for (const [name, value] of Object.entries(existingConfig)) assert.equal(saved[name], value);
  t.diagnostic(`CLI=${release.cliVersion}; Node=${release.node.version}; skills=${installed.skillCount}; first/repeat/verify/update/repair/reuse=0; Node downloads=2; prior identity preserved`);
  } catch (error) {
    process.stderr.write(String(error.stack ?? error) + '\n' + String(error.stdout ?? '').slice(-8000) + '\n' + String(error.stderr ?? '').slice(-8000) + '\n');
    throw error;
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server) { server.closeAllConnections(); server.close(); }
  }
});
