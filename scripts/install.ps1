param([switch]$CurrentDirectory, [switch]$ProgramOnly, [switch]$Repair)
$ErrorActionPreference = 'Stop'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('postplus-entry-' + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $temp | Out-Null
  $installer = Join-Path $temp 'install.ps1'
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
    # Native stderr is captured even under Windows PowerShell ErrorActionPreference=Stop.
    $savedPreference = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      $metrics = @(& curl.exe --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 --write-out '%{http_code}\n%{time_total}\n%{url_effective}\n' $url -o $file 2> (Join-Path $temp 'error'))
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
  $arch = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  Download-Component https://postplus.io/install.ps1 $installer installer latest
  $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $installer)
  if ($CurrentDirectory) { $arguments += '-CurrentDirectory' }
  if ($ProgramOnly) { $arguments += '-ProgramOnly' }
  if ($Repair) { $arguments += '-Repair' }
  & powershell.exe @arguments
  if ($LASTEXITCODE -ne 0) { throw 'PostPlus setup did not complete.' }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
