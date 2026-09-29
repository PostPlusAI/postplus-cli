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
if command -v sha256sum >/dev/null 2>&1; then checksum() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then checksum() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else fail 'This environment cannot verify PostPlus downloads.'; fi
install_root="\${POSTPLUS_INSTALL_ROOT:-\${XDG_DATA_HOME:-$HOME/.local/share}/postplus}"
temp=$(mktemp -d "\${TMPDIR:-/tmp}/postplus-setup.XXXXXXXX") || fail 'A temporary installation directory could not be created.'
trap 'rm -rf "$temp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
download() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 "$1" -o "$2" || fail 'The environment could not download the required PostPlus components.'; }
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
  download "$node_url" "$temp/node.tar.gz"
  [ "$(checksum "$temp/node.tar.gz")" = "$node_sha" ] || fail 'The Node download failed integrity verification.'
  mkdir "$temp/node"
  tar -xzf "$temp/node.tar.gz" -C "$temp/node" || fail 'The Node archive could not be unpacked.'
  runtime_node="$temp/node/$node_directory/bin/node"
  node_archive="$temp/node.tar.gz"
fi
download ${quote(release.cli.url)} "$temp/cli.tar.gz"
[ "$(checksum "$temp/cli.tar.gz")" = ${quote(release.cli.sha256)} ] || fail 'The PostPlus download failed integrity verification.'
mkdir "$temp/cli"
tar -xzf "$temp/cli.tar.gz" -C "$temp/cli" || fail 'The PostPlus archive could not be unpacked.'
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
  function Download-Verified($url, $digest, $file) {
    # Do not use an unverified system Node or npm during bootstrap.
    $tlsArgs = if ($env:CURL_CA_BUNDLE) { @('--cacert', $env:CURL_CA_BUNDLE) } else { @() }
    & curl.exe @tlsArgs --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 $url -o $file
    if ($LASTEXITCODE -ne 0) { throw ('This environment could not download PostPlus components (curl exit ' + $LASTEXITCODE + ').') }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() -ne $digest) { throw 'PostPlus download integrity verification failed.' }
  }
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
    Download-Verified $artifact.url $artifact.sha256 $nodeArchive
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath (Join-Path $temp 'node')
    $node = Join-Path (Join-Path $temp 'node') ($artifact.directory + '/node.exe')
  }
  $cliArchive = Join-Path $temp 'cli.tar.gz'
  Download-Verified $release.cli.url $release.cli.sha256 $cliArchive
  New-Item -ItemType Directory -Path (Join-Path $temp 'cli') | Out-Null
  & (Join-Path $env:SystemRoot 'System32/tar.exe') -xzf $cliArchive -C (Join-Path $temp 'cli')
  if ($LASTEXITCODE -ne 0) { throw 'PostPlus archive could not be unpacked.' }
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
