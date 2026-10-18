import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeManagedRelease(root, version, skillsReleaseId, sha256, options = {}) {
  const node = JSON.parse(await readFile(join(root, 'runtime-manager/node-releases.json'), 'utf8'));
  const origin = options.artifactBaseUrl ?? `https://github.com/PostPlusAI/postplus-cli/releases/download/v${version}/`;
  if (new URL(origin).protocol !== 'https:') throw new Error('Managed release artifacts require HTTPS.');
  const release = { schemaVersion: 1, releaseId: skillsReleaseId, cliVersion: version, skillsReleaseId,
    cli: { url: new URL(`postplus-cli-v${version}.tar.gz`, origin).href, sha256, directory: 'postplus-cli' }, node };
  await writeFile(join(root, 'dist/postplus-runtime.json'), JSON.stringify(release, null, 2) + '\n');
  return release;
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

// These helpers run before a trusted Node runtime exists. Only fixed, recognized
// curl phrases leave stderr; arbitrary proxy/server text may contain credentials.
const shellDiagnostics = String.raw`
safe_url() {
  case "$1" in https://*|http://*) ;; *) printf '%s' '[unavailable]'; return ;; esac
  printf '%s' "$1" | sed -E 's/[?#].*$//; s#(https?://)[^/]*@#\1#; s/[[:cntrl:]]//g' | cut -c 1-512
}
error_summary() {
  summary='[unrecognized stderr redacted]'
  if [ -s "$temp/error" ]; then
    for phrase in 'Could not resolve proxy' 'Could not resolve host' 'Failed to connect' 'Connection refused' 'Connection timed out' 'Operation timed out' 'SSL certificate problem' 'SSL connect error' 'The requested URL returned error' 'Empty reply from server' 'Recv failure' 'Failure writing output'; do
      if LC_ALL=C grep -F "$phrase" "$temp/error" >/dev/null 2>&1; then summary="$phrase"; break; fi
    done
  else summary='[no stderr]'; fi
}
diagnostic() {
  proxy_configured=false
  for proxy_name in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy; do
    if [ -n "$(printenv "$proxy_name" 2>/dev/null)" ]; then proxy_configured=true; fi
  done
  error_summary
  printf 'PostPlus setup failed: operation=install component=%s stage=%s platform=%s arch=%s target_version=%s current_version=unknown proxy_configured=%s error_code=%s http_status=%s elapsed_seconds=%s connect_timeout_seconds=20 total_timeout_seconds=300\noriginal_url=%s\neffective_url=%s\nerror_summary=%s\nnext_step=In the same Agent environment: %s\n' "$component" "$stage" "$platform" "$arch" "$target_version" "$proxy_configured" "$1" "$http_status" "$elapsed" "$(safe_url "$original_url")" "$(safe_url "$effective_url")" "$summary" "$2" >&2
}
download() {
  original_url=$1; effective_url='[unavailable]'; component=$3; target_version=$4; stage=download; http_status=unknown
  started=$(date +%s)
  code=0
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 --write-out '%{http_code}\n%{time_total}\n%{url_effective}\n' "$1" -o "$2" > "$temp/metrics" 2> "$temp/error" || code=$?
  elapsed=$(($(date +%s) - started))
  { IFS= read -r http_status; IFS= read -r measured; IFS= read -r effective_url; } < "$temp/metrics" || :
  case "$http_status" in 000) http_status=unknown ;; [0-9][0-9][0-9]) ;; *) http_status=unknown ;; esac
  case "$measured" in ''|*[!0-9.]*) ;; *) elapsed=$measured ;; esac
  if [ "$code" -ne 0 ]; then
    next='Check access to the reported HTTPS host and configured proxy, then rerun the installer.'
    case "$code" in
      28) next='The transfer timed out; check connectivity/proxy and rerun. A timeout alone does not identify a TLS failure.' ;;
      35|60) next='Check the reported TLS/certificate failure and the trusted CA/proxy configuration, then rerun; do not disable certificate verification.' ;;
      22) next='Check the HTTP status and release URL availability, then rerun the installer.' ;;
    esac
    diagnostic "$code" "$next"; exit 1
  fi
}
verify_archive() {
  stage=verify; started=$(date +%s); code=0
  actual=$(checksum "$1" 2> "$temp/error") || code=$?
  elapsed=$(($(date +%s) - started))
  if [ "$code" -ne 0 ] || [ "$actual" != "$2" ]; then
    [ "$code" -ne 0 ] || code=checksum_mismatch
    diagnostic "$code" 'Rerun the installer to fetch a fresh archive; if verification fails again, report this component and target version.'; exit 1
  fi
}
unpack_archive() {
  stage=extract; started=$(date +%s); code=0
  tar -xzf "$1" -C "$2" > /dev/null 2> "$temp/error" || code=$?
  elapsed=$(($(date +%s) - started))
  if [ "$code" -ne 0 ]; then diagnostic "$code" 'Check free disk space and tar availability, then rerun to fetch and unpack a fresh archive.'; exit 1; fi
}
`;

const powershellDiagnostics = String.raw`
function Safe-Url($value) {
  # Drop query, fragment and credentials before any URL reaches the terminal.
  if ($value -notmatch '^https?://') { return '[unavailable]' }
  $safe = ($value -replace '[?#].*$', '' -replace '(https?://)[^/]*@', '$1' -replace '[\x00-\x1f\x7f]', '')
  if ($safe.Length -gt 512) { $safe = $safe.Substring(0,512) }
  return $safe
}
function Write-Diagnostic($stage, $code, $elapsed, $next) {
  $proxyConfigured = [bool]($env:HTTPS_PROXY -or $env:HTTP_PROXY -or $env:ALL_PROXY)
  $summary = '[unrecognized stderr redacted]'
  $raw = if (Test-Path -LiteralPath (Join-Path $temp 'error')) { [IO.File]::ReadAllText((Join-Path $temp 'error')) } else { '' }
  if (-not $raw) { $summary = '[no stderr]' }
  foreach ($phrase in @('Could not resolve proxy', 'Could not resolve host', 'Failed to connect', 'Connection refused', 'Connection timed out', 'Operation timed out', 'SSL certificate problem', 'SSL connect error', 'The requested URL returned error', 'Empty reply from server', 'Recv failure', 'Failure writing output')) {
    if ($raw.Contains($phrase)) { $summary = $phrase; break }
  }
  [Console]::Error.WriteLine(('PostPlus setup failed: operation=install component={0} stage={1} platform=win32 arch={2} target_version={3} current_version=unknown proxy_configured={7} error_code={4} http_status={5} elapsed_seconds={6} connect_timeout_seconds=20 total_timeout_seconds=300' -f $script:component,$stage,$arch,$script:targetVersion,$code,$script:httpStatus,$elapsed,$proxyConfigured.ToString().ToLowerInvariant()))
  [Console]::Error.WriteLine('original_url=' + (Safe-Url $script:originalUrl))
  [Console]::Error.WriteLine('effective_url=' + (Safe-Url $script:effectiveUrl))
  [Console]::Error.WriteLine('error_summary=' + $summary)
  [Console]::Error.WriteLine('next_step=In the same Agent environment: ' + $next)
}
function Download-Component($url, $file, $name, $version) {
  $script:component = $name; $script:targetVersion = $version
  $script:originalUrl = $url; $script:effectiveUrl = '[unavailable]'; $script:httpStatus = 'unknown'
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $code = 'curl_unavailable'; $metrics = @()
  try {
    $tlsArgs = if ($env:CURL_CA_BUNDLE) { @('--cacert', $env:CURL_CA_BUNDLE) } else { @() }
    # Native stderr is captured even under Windows PowerShell ErrorActionPreference=Stop.
    $savedPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $metrics = @(& curl.exe @tlsArgs --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 --write-out '%{http_code}\n%{time_total}\n%{url_effective}\n' $url -o $file 2> (Join-Path $temp 'error'))
      $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
  } catch { $code = 'curl_unavailable' }
  $metrics = @(($metrics -join [Environment]::NewLine) -split '\r?\n')
  $elapsed = $timer.Elapsed.TotalSeconds.ToString('F3', [Globalization.CultureInfo]::InvariantCulture)
  if ($metrics.Count -ge 3) {
    if ($metrics[0] -match '^\d{3}$' -and $metrics[0] -ne '000') { $script:httpStatus = $metrics[0] }; $script:effectiveUrl = $metrics[2]
    if ($metrics[1] -match '^\d+(\.\d+)?$') { $elapsed = $metrics[1] }
  }
  if ($code -ne 0) {
    $next = 'Check access to the reported HTTPS host and configured proxy, then rerun the installer.'
    if ($code -eq 28) { $next = 'The transfer timed out; check connectivity/proxy and rerun. A timeout alone does not identify a TLS failure.' }
    if ($code -in @(35,60)) { $next = 'Check the reported TLS/certificate failure and trusted CA/proxy configuration, then rerun; do not disable certificate verification.' }
    if ($code -eq 22) { $next = 'Check the HTTP status and release URL availability, then rerun the installer.' }
    Write-Diagnostic 'download' $code $elapsed $next
    exit 1
  }
}
function Verify-Archive($file, $digest) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $code = 'checksum_mismatch'
  try {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() -eq $digest) { return }
  } catch { $code = 'checksum_failed' }
  Write-Diagnostic 'verify' $code $timer.Elapsed.TotalSeconds.ToString('F3', [Globalization.CultureInfo]::InvariantCulture) 'Rerun the installer to fetch a fresh archive; if verification fails again, report this component and target version.'
  exit 1
}
function Expand-ArchiveTar($file, $directory) {
  $timer = [Diagnostics.Stopwatch]::StartNew(); $code = 'tar_unavailable'
  try {
    $savedPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      & (Join-Path $env:SystemRoot 'System32/tar.exe') -xf $file -C $directory > $null 2> (Join-Path $temp 'error')
      $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
  } catch { $code = 'tar_unavailable' }
  if ($code -ne 0) {
    Write-Diagnostic 'extract' $code $timer.Elapsed.TotalSeconds.ToString('F3', [Globalization.CultureInfo]::InvariantCulture) 'Check free disk space and tar availability, then rerun to fetch and unpack a fresh archive.'
    exit 1
  }
}
`;

export async function writeBootstrapScripts(root, release) {
  const cases = Object.entries(release.node.artifacts).filter(([key]) => !key.startsWith('win32')).map(([key, artifact]) =>
    `  ${key}) node_url=${quote(artifact.url)}; node_sha=${quote(artifact.sha256)}; node_directory=${quote(artifact.directory)} ;;`).join('\n');
  const script = `#!/bin/sh
set -eu
fail() { printf 'PostPlus setup could not finish: %s\\n' "$1" >&2; exit 1; }
for argument in "$@"; do
  case "$argument" in --current-directory|--program-only|--repair) ;; *) fail 'Unknown PostPlus installer option.' ;; esac
done
case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail 'This operating system is not supported by this installer.' ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'This processor is not supported by this installer.' ;; esac
case "$platform-$arch" in
${cases}
  *) fail 'No PostPlus runtime is available for this platform.' ;;
esac
command -v curl >/dev/null 2>&1 || fail 'This environment does not provide curl to download PostPlus.'
command -v tar >/dev/null 2>&1 || fail 'This environment does not provide tar to unpack PostPlus.'
if command -v sha256sum >/dev/null 2>&1; then checksum() { checksum_output=$(sha256sum "$1") || return $?; printf '%s\\n' "$checksum_output" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then checksum() { checksum_output=$(shasum -a 256 "$1") || return $?; printf '%s\\n' "$checksum_output" | cut -d ' ' -f 1; }
else fail 'This environment cannot verify PostPlus downloads.'; fi
install_root="\${POSTPLUS_INSTALL_ROOT:-\${XDG_DATA_HOME:-$HOME/.local/share}/postplus}"
temp=$(mktemp -d "\${TMPDIR:-/tmp}/postplus-setup.XXXXXXXX") || fail 'A temporary installation directory could not be created.'
trap 'rm -rf "$temp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
${shellDiagnostics}
printf '%s\\n' 'Preparing the PostPlus runtime and program. Your system Node will not be changed.' >&2
unset NODE_OPTIONS NODE_PATH
repair=''
for argument in "$@"; do [ "$argument" != --repair ] || repair=--repair; done
node_archive=''
runtime_node="$install_root/runtimes/node-v${release.node.version}-$platform-$arch-$(printf '%.12s' "$node_sha")/bin/node"
if [ -z "$repair" ] && [ -f "$install_root/active" ]; then
  { IFS= read -r record_header; IFS= read -r record_cli; IFS= read -r record_version; IFS= read -r record_node; } < "$install_root/active" || fail 'The PostPlus installation record needs --repair.'
  if [ "$record_header" = postplus-installation-v1 ] && [ "$record_version" = ${quote(release.node.version)} ]; then
    case "$record_node" in *..*|*[!A-Za-z0-9_./-]*) fail 'The PostPlus installation record needs --repair.' ;; esac
    case "$record_node" in runtimes/node-v${release.node.version}-$platform-$arch-$(printf '%.12s' "$node_sha")*/bin/node) runtime_node="$install_root/$record_node" ;; *) fail 'The PostPlus installation record needs --repair.' ;; esac
  fi
fi
if [ -z "$repair" ] && [ -x "$runtime_node" ]; then
  [ "$("$runtime_node" --version)" = ${quote('v' + release.node.version)} ] || fail 'The existing PostPlus runtime needs repair.'
else
  download "$node_url" "$temp/node.tar.gz" node ${quote(release.node.version)}
  verify_archive "$temp/node.tar.gz" "$node_sha"
  mkdir "$temp/node"
  unpack_archive "$temp/node.tar.gz" "$temp/node"
  runtime_node="$temp/node/$node_directory/bin/node"
  node_archive="$temp/node.tar.gz"
fi
download ${quote(release.cli.url)} "$temp/cli.tar.gz" cli ${quote(release.cliVersion)}
verify_archive "$temp/cli.tar.gz" ${quote(release.cli.sha256)}
mkdir "$temp/cli"
unpack_archive "$temp/cli.tar.gz" "$temp/cli"
cat > "$temp/release.json" <<'POSTPLUS_RELEASE_JSON'
${JSON.stringify(release, null, 2)}
POSTPLUS_RELEASE_JSON
scope=''
program_only=''
for argument in "$@"; do
  case "$argument" in --current-directory) scope="$argument" ;; --program-only) program_only="$argument" ;; esac
done
set -- install --root "$install_root" --release-file "$temp/release.json" --cli-archive "$temp/cli.tar.gz"
if [ -n "$node_archive" ]; then set -- "$@" --node-archive "$node_archive"; fi
if [ -n "$scope" ]; then set -- "$@" "$scope"; fi
if [ -n "$program_only" ]; then set -- "$@" "$program_only"; fi
if [ -n "$repair" ]; then set -- "$@" "$repair"; fi
"$runtime_node" "$temp/cli/${release.cli.directory}/runtime-manager/index.mjs" "$@"
`;
  await writeFile(join(root, 'dist/install.sh'), script, { mode: 0o755 });
  const windows = Object.fromEntries(Object.entries(release.node.artifacts).filter(([key]) => key.startsWith('win32-')));
  const ps = `param([switch]$CurrentDirectory, [switch]$ProgramOnly, [switch]$Repair)
$ErrorActionPreference = 'Stop'
$temp = $null
try {
  $release = @'
${JSON.stringify(release, null, 2)}
'@ | ConvertFrom-Json
  $arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  $artifact = $release.node.artifacts.('win32-' + $arch)
  if (-not $artifact) { throw 'No PostPlus runtime is available for this processor.' }
  $installRoot = if ($env:POSTPLUS_INSTALL_ROOT) { $env:POSTPLUS_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA 'PostPlus' }
  $temp = Join-Path ([IO.Path]::GetTempPath()) ('postplus-setup-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp | Out-Null
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
${powershellDiagnostics}
  [Console]::Error.WriteLine('Preparing the PostPlus runtime and program. Your system Node will not be changed.')
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
  $nodeArchive = $null
  $node = Join-Path $installRoot ('runtimes/node-v' + $release.node.version + '-win32-' + $arch + '-' + $artifact.sha256.Substring(0,12) + '/node.exe')
  $activeFile = Join-Path $installRoot 'active'
  if (-not $Repair -and (Test-Path -LiteralPath $activeFile -PathType Leaf)) {
    $active = [IO.File]::ReadAllLines($activeFile)
    if ($active.Length -ne 6 -or $active[0] -ne 'postplus-installation-v1') { throw 'The PostPlus installation record needs -Repair.' }
    if ($active[2] -eq $release.node.version) {
      $relativeNode = $active[3]
      if ($relativeNode -notmatch '^[A-Za-z0-9_./-]+$' -or $relativeNode.Contains('..') -or
          -not $relativeNode.StartsWith('runtimes/node-v' + $release.node.version + '-win32-' + $arch + '-' + $artifact.sha256.Substring(0,12)) -or
          -not $relativeNode.EndsWith('/node.exe')) { throw 'The PostPlus installation record needs -Repair.' }
      $node = Join-Path $installRoot $relativeNode
    }
  }
  if (-not $Repair -and (Test-Path -LiteralPath $node -PathType Leaf)) {
    $version = & $node --version
    if ($LASTEXITCODE -ne 0 -or $version -ne ('v' + $release.node.version)) { throw 'The existing PostPlus runtime needs repair.' }
  } else {
    $nodeArchive = Join-Path $temp 'node.zip'
    [Console]::Error.WriteLine('Downloading the verified PostPlus runtime.')
    Download-Component $artifact.url $nodeArchive node $release.node.version
    Verify-Archive $nodeArchive $artifact.sha256
    [Console]::Error.WriteLine('Unpacking the PostPlus runtime.')
    New-Item -ItemType Directory -Path (Join-Path $temp 'node') | Out-Null
    Expand-ArchiveTar $nodeArchive (Join-Path $temp 'node')
    $node = Join-Path (Join-Path $temp 'node') ($artifact.directory + '/node.exe')
  }
  $cliArchive = Join-Path $temp 'cli.tar.gz'
  [Console]::Error.WriteLine('Downloading the matching PostPlus program.')
  Download-Component $release.cli.url $cliArchive cli $release.cliVersion
  Verify-Archive $cliArchive $release.cli.sha256
  [Console]::Error.WriteLine('Unpacking the PostPlus program.')
  New-Item -ItemType Directory -Path (Join-Path $temp 'cli') | Out-Null
  Expand-ArchiveTar $cliArchive (Join-Path $temp 'cli')
  $releaseFile = Join-Path $temp 'release.json'
  [IO.File]::WriteAllText($releaseFile, ($release | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
  $manager = Join-Path (Join-Path $temp 'cli') ($release.cli.directory + '/runtime-manager/index.mjs')
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
  $setupArgs = @($manager, 'install', '--root', $installRoot, '--release-file', $releaseFile, '--cli-archive', $cliArchive)
  if ($nodeArchive) { $setupArgs += @('--node-archive', $nodeArchive) }
  if ($CurrentDirectory) { $setupArgs += '--current-directory' }
  if ($ProgramOnly) { $setupArgs += '--program-only' }
  if ($Repair) { $setupArgs += '--repair' }
  [Console]::Error.WriteLine('Verifying and activating PostPlus and its skills.')
  & $node @setupArgs
  if ($LASTEXITCODE -ne 0) { throw 'PostPlus setup did not finish; see its result above.' }
} catch {
  [Console]::Error.WriteLine('PostPlus setup could not finish: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
`;
  if (Object.keys(windows).length) await writeFile(join(root, 'dist/install.ps1'), ps);
}
