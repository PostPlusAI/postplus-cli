import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { writeBootstrapScripts } from './build-runtime-installers.mjs';

const source = new URL('./', import.meta.url);
const digest = 'a'.repeat(64);
const release = {
  cliVersion: '0.2.21', cli: { url: 'https://user:secret@release.invalid/cli.tar.gz?token=private#fragment', sha256: digest, directory: 'postplus-cli' },
  node: { version: '24.21.0', artifacts: Object.fromEntries(['linux-x64', 'win32-x64', 'win32-arm64'].map(key => [key, {
    url: 'https://user:secret@node.invalid/node.tar.gz?token=private#fragment', sha256: digest, directory: 'fixture-node',
  }])) },
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'postplus-bootstrap-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist')); await mkdir(join(root, 'bin'));
  await writeBootstrapScripts(root, release);
  const scripts = {
    uname: '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
    curl: `#!/bin/sh
out=''; url=''
for arg in "$@"; do printf '%s\\n' "$arg" >> "$CURL_ARGS"; done
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out=$2; shift ;; https://*) url=$1 ;; esac
  shift
done
case "$out" in *install.sh) component=installer ;; *node.tar.gz) component=node ;; *) component=cli ;; esac
if [ "$component" = installer ]; then cp "$ENTRY_PAYLOAD" "$out"; else : > "$out"; fi
[ -n "$NO_METRICS" ] || printf '%s\\n%s\\n%s\\n' "\${HTTP_STATUS:-200}" "\${ELAPSED:-0.125}" "\${EFFECTIVE_URL:-https://proxy:password@cdn.invalid/archive?signature=hidden#secret}"
if [ "$component" = "$FAIL_COMPONENT" ] && [ "$FAIL_STAGE" = download ]; then
  printf '%s\\n' "$CURL_ERROR" >&2
  exit "$CURL_CODE"
fi
`,
    sha256sum: `#!/bin/sh
case "$1" in *node.tar.gz) component=node ;; *) component=cli ;; esac
if [ "$component" = "$FAIL_COMPONENT" ] && [ "$FAIL_STAGE" = verify ]; then
  echo 'sensitive /Users/private/path Authorization: Bearer secret' >&2
  echo 'bad  archive'; [ -n "$HASH_MISMATCH" ] && exit 0; exit 2
fi
printf '%s  archive\\n' '${digest}'
`,
    tar: `#!/bin/sh
case "$2" in *node.tar.gz) component=node ;; *) component=cli ;; esac
if [ "$component" = "$FAIL_COMPONENT" ] && [ "$FAIL_STAGE" = extract ]; then
  echo 'sensitive /Users/private/path Authorization: Bearer secret' >&2
  exit 2
fi
if [ "$component" = node ]; then
  mkdir -p "$4/fixture-node/bin"
  cp "$FAKE_NODE" "$4/fixture-node/bin/node"
fi
`,
  };
  for (const [name, content] of Object.entries(scripts)) {
    const path = join(root, 'bin', name); await writeFile(path, content); await chmod(path, 0o755);
  }
  const fakeNode = join(root, 'fake-node');
  await writeFile(fakeNode, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SUCCESS_ARGS"\n'); await chmod(fakeNode, 0o755);
  const payload = join(root, 'entry-payload'); await writeFile(payload, '#!/bin/sh\nprintf "%s\\n" "$@" > "$SUCCESS_ARGS"\n');
  const env = { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: root, POSTPLUS_INSTALL_ROOT: join(root, 'install'),
    TMPDIR: root, CURL_ARGS: join(root, 'curl-args'), SUCCESS_ARGS: join(root, 'success'), FAKE_NODE: fakeNode, ENTRY_PAYLOAD: payload,
    FAIL_STAGE: '', FAIL_COMPONENT: '', CURL_CODE: '0', CURL_ERROR: '' };
  return { root, env, run: (entry, overrides = {}) => spawnSync('/bin/sh', [entry ? fileURLToPath(new URL('install.sh', source)) : join(root, 'dist/install.sh'), '--program-only'], {
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
  }) };
}

for (const entry of [false, true]) {
  const label = entry ? 'entry' : 'generated';
  for (const [code, status, error, phrase] of [
    [6, '000', 'Could not resolve host: private.invalid', 'Could not resolve host'],
    [28, '000', 'Operation timed out after 140000 milliseconds', 'Operation timed out'],
    [60, '000', 'SSL certificate problem: private CA', 'SSL certificate problem'],
    [35, '000', 'SSL connect error: private proxy', 'SSL connect error'],
    [22, '403', 'The requested URL returned error: 403', 'The requested URL returned error'],
  ]) {
    test(`${label} download preserves curl ${code}, safe redirect and actual duration`, { skip: process.platform === 'win32' && 'POSIX execution fixture' }, async t => {
      const f = await fixture(t);
      const result = f.run(entry, { FAIL_STAGE: 'download', FAIL_COMPONENT: entry ? 'installer' : 'node', CURL_CODE: String(code),
        HTTP_STATUS: status, ELAPSED: '140.250', CURL_ERROR: `${error}\nhttps://user:password@private.invalid?token=hidden\nAuthorization: Bearer secret\n/Users/private/path` });
      assert.equal(result.status, entry ? code : 1, result.stderr);
      assert.match(result.stderr, /current_version=unknown proxy_configured=false/);
      assert.match(result.stderr, /operation=install/);
      assert.match(result.stderr, new RegExp(`component=${entry ? 'installer' : 'node'} stage=download platform=linux arch=${entry ? 'x86_64' : 'x64'}`));
      assert.match(result.stderr, new RegExp(`target_version=${entry ? 'unknown' : '24.21.0'}`));
      assert.match(result.stderr, new RegExp(`error_code=${code} http_status=${status === '000' ? 'unknown' : status} elapsed_seconds=140.250`));
      assert.match(result.stderr, /connect_timeout_seconds=20 total_timeout_seconds=300/);
      assert.match(result.stderr, /effective_url=https:\/\/cdn.invalid\/archive/);
      assert.ok(result.stderr.includes(`error_summary=${phrase}`)); assert.match(result.stderr, /next_step=In the same Agent environment: .+/);
      assert.doesNotMatch(result.stderr, /secret|password|signature|hidden|Authorization|\/Users\/private|token=|user:/);
      if (code === 28) assert.doesNotMatch(result.stderr, /Check the reported TLS\/certificate failure/);
      const args = await readFile(f.env.CURL_ARGS, 'utf8');
      assert.match(args, /--connect-timeout\n20\n--max-time\n300\n/);
      assert.match(args, /--proto\n=https\n--proto-redir\n=https/);
      assert.doesNotMatch(args, /--retry|--insecure/);
    });
  }
  test(`${label} captures unknown stderr and unsafe metrics without disclosure`, { skip: process.platform === 'win32' && 'POSIX execution fixture' }, async t => {
    const f = await fixture(t);
    const result = f.run(entry, { FAIL_STAGE: 'download', FAIL_COMPONENT: entry ? 'installer' : 'node', CURL_CODE: '7', CURL_ERROR: 'private unrecognized proxy credentials', EFFECTIVE_URL: 'Authorization: Bearer secret' });
    assert.equal(result.status, entry ? 7 : 1); assert.match(result.stderr, /effective_url=\[unavailable\]/);
    assert.match(result.stderr, /error_summary=\[unrecognized stderr redacted\]/);
    assert.doesNotMatch(result.stderr, /credentials|Bearer|Authorization/);
  });
  test(`${label} successful transfer beyond 120 seconds forwards options`, { skip: process.platform === 'win32' && 'POSIX execution fixture' }, async t => {
    const f = await fixture(t); const result = f.run(entry, { ELAPSED: '140.250' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(f.env.SUCCESS_ARGS, 'utf8'), /--program-only/);
    assert.doesNotMatch(result.stderr, /failed|secret|password/);
  });
}
for (const component of ['node', 'cli']) {
  for (const stage of ['verify', 'extract']) {
    test(`${component} ${stage} failure identifies its phase without raw stderr`, { skip: process.platform === 'win32' && 'POSIX execution fixture' }, async t => {
      const f = await fixture(t); const result = f.run(false, { FAIL_COMPONENT: component, FAIL_STAGE: stage });
      assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(`component=${component} stage=${stage}`));
      assert.match(result.stderr, new RegExp(`target_version=${component === 'node' ? '24.21.0' : '0.2.21'}`));
      assert.match(result.stderr, /error_code=2 http_status=200 elapsed_seconds=/);
      assert.doesNotMatch(result.stderr, /sensitive|\/Users\/private|Authorization|secret|password/);
    });
  }
}
test('CLI download failure uses CLI target version and sanitized original URL', { skip: process.platform === 'win32' && 'POSIX execution fixture' }, async t => {
  const f = await fixture(t); const result = f.run(false, { FAIL_COMPONENT: 'cli', FAIL_STAGE: 'download', CURL_CODE: '22', HTTP_STATUS: '404' });
  assert.equal(result.status, 1); assert.match(result.stderr, /component=cli stage=download.*target_version=0.2.21/);
  assert.match(result.stderr, /original_url=https:\/\/release.invalid\/cli.tar.gz/);
  assert.doesNotMatch(result.stderr, /user:|secret|token=|fragment/);
});
test('Windows generated and entry scripts retain explicit bounded download diagnostics (static only)', async t => {
  const f = await fixture(t);
  for (const script of [await readFile(join(f.root, 'dist/install.ps1'), 'utf8'), await readFile(new URL('install.ps1', source), 'utf8')]) {
    assert.match(script, /--connect-timeout 20 --max-time 300 --write-out/);
    assert.match(script, /operation=install component=\{0\} stage=\{1\} platform=win32/);
    assert.match(script, /\$code = \$LASTEXITCODE/); assert.match(script, /Stopwatch/);
    assert.match(script, /Safe-Url \$script:effectiveUrl/); assert.match(script, /\$summary = \$phrase/);
    assert.match(script, /timeout alone does not identify a TLS failure/);
    assert.doesNotMatch(script, /--retry|--insecure/);
  }
});

// Functions preserve the native curl call contract without network access or a
// compiler. The script's stderr redirect still captures PowerShell ErrorRecords.
async function runWindows(f, entry, overrides) {
  const wrapper = join(f.root, 'windows-fixture.ps1');
  await writeFile(wrapper, `
function global:curl.exe {
  $file = $args[[Array]::IndexOf($args, '-o') + 1]
  [IO.File]::WriteAllText($file, 'not an archive')
  $lines = @($env:HTTP_STATUS, $env:ELAPSED, 'https://proxy:password@cdn.invalid/archive?signature=hidden#secret')
  if ($env:SINGLE_METRICS_STRING) { Write-Output ($lines -join [Environment]::NewLine) } else { Write-Output $lines }
  if ($env:CURL_ERROR) { Write-Error -Message $env:CURL_ERROR -ErrorAction Continue }
  $global:LASTEXITCODE = [int]$env:CURL_CODE
}
function global:Get-FileHash {
  if ($env:HASH_ERROR) { throw 'private path C:\\Users\\private Authorization: Bearer secret' }
  return @{ Hash = $env:HASH_VALUE }
}
. $env:BOOTSTRAP_SCRIPT -ProgramOnly
`);
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
    env: { ...process.env, POSTPLUS_INSTALL_ROOT: join(f.root, 'install'),
      BOOTSTRAP_SCRIPT: entry ? fileURLToPath(new URL('install.ps1', source)) : join(f.root, 'dist/install.ps1'),
      HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '', HTTP_STATUS: '000', ELAPSED: '140.250', CURL_CODE: '28', CURL_ERROR: '', HASH_VALUE: digest, ...overrides },
    encoding: 'utf8', timeout: 10000,
  });
}
for (const entry of [false, true]) {
  for (const [code, status, message] of [[6, '000', 'Could not resolve host'], [28, '000', 'Operation timed out'], [35, '000', 'SSL connect error'], [60, '000', 'SSL certificate problem'], [22, '403', 'The requested URL returned error']]) {
    test(`Windows ${entry ? 'entry' : 'generated'} executes curl ${code} diagnostics`, { skip: process.platform !== 'win32' && 'Windows PowerShell execution requires Windows' }, async t => {
      const f = await fixture(t); const result = await runWindows(f, entry, { CURL_CODE: String(code), HTTP_STATUS: status,
        CURL_ERROR: `${message}: https://user:password@private.invalid?token=hidden Authorization: Bearer secret C:\\Users\\private` });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, new RegExp(`component=${entry ? 'installer' : 'node'} stage=download platform=win32`));
      assert.match(result.stderr, new RegExp(`target_version=${entry ? 'unknown' : '24.21.0'} current_version=unknown proxy_configured=false error_code=${code} http_status=${status === '000' ? 'unknown' : status} elapsed_seconds=140.250`));
      assert.match(result.stderr, /effective_url=https:\/\/cdn.invalid\/archive/);
      assert.ok(result.stderr.includes(`error_summary=${message}`));
      assert.match(result.stderr, /connect_timeout_seconds=20 total_timeout_seconds=300/);
      assert.match(result.stderr, /next_step=In the same Agent environment: .+/);
      assert.doesNotMatch(result.stderr, /password|hidden|Authorization|Bearer|C:\\Users\\private|token=|user:/);
    });
  }
}
for (const stage of ['verify', 'extract']) {
  test(`Windows generated executes ${stage} diagnostics`, { skip: process.platform !== 'win32' && 'Windows PowerShell execution requires Windows' }, async t => {
    const f = await fixture(t);
    const result = await runWindows(f, false, { CURL_CODE: '0', HTTP_STATUS: '200', HASH_VALUE: stage === 'verify' ? 'bad' : digest });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, new RegExp(`component=node stage=${stage} platform=win32`));
    assert.match(result.stderr, /target_version=24.21.0 current_version=unknown proxy_configured=\w+ error_code=.+ http_status=200 elapsed_seconds=/);
    assert.doesNotMatch(result.stderr, /password|hidden|Authorization|Bearer|postplus-setup-|token=|user:/);
  });
}
for (const component of ['node', 'cli']) {
  test(`${component} checksum mismatch is distinct from checksum tool failure`, { skip: process.platform === 'win32' && 'POSIX execution fixture' }, async t => {
    const f = await fixture(t); const result = f.run(false, { FAIL_COMPONENT: component, FAIL_STAGE: 'verify', HASH_MISMATCH: '1' });
    assert.equal(result.status, 1); assert.match(result.stderr, /stage=verify.*error_code=checksum_mismatch/);
    assert.doesNotMatch(result.stderr, /sensitive|Authorization|\/Users\/private/);
  });
}
for (const entry of [false, true]) {
  test(`${entry ? 'entry' : 'generated'} reports proxy presence without its credentials`, { skip: process.platform === 'win32' && 'POSIX execution fixture' }, async t => {
    const f = await fixture(t); const result = f.run(entry, { FAIL_COMPONENT: entry ? 'installer' : 'node', FAIL_STAGE: 'download', CURL_CODE: '7', HTTPS_PROXY: 'https://private:credential@proxy.invalid:8080' });
    assert.match(result.stderr, /current_version=unknown proxy_configured=true/);
    assert.doesNotMatch(result.stderr, /credential|proxy.invalid|private:/);
  });
}
for (const entry of [false, true]) {
  test(`${entry ? 'entry' : 'generated'} reports wall time when curl supplies no metrics`, { skip: process.platform === 'win32' && 'POSIX execution fixture' }, async t => {
    const f = await fixture(t); const result = f.run(entry, { FAIL_COMPONENT: entry ? 'installer' : 'node', FAIL_STAGE: 'download', CURL_CODE: '7', NO_METRICS: '1' });
    assert.equal(result.status, entry ? 7 : 1);
    assert.match(result.stderr, /error_code=7 http_status=unknown elapsed_seconds=\d+ connect_timeout_seconds=20/);
    assert.match(result.stderr, /effective_url=\[unavailable\]/);
  });
}
test('Windows parses a single metrics string containing newlines', { skip: process.platform !== 'win32' && 'Windows PowerShell execution requires Windows' }, async t => {
  const f = await fixture(t); const result = await runWindows(f, false, { SINGLE_METRICS_STRING: '1' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /error_code=28 http_status=unknown elapsed_seconds=140.250/);
  assert.match(result.stderr, /effective_url=https:\/\/cdn.invalid\/archive/);
});
