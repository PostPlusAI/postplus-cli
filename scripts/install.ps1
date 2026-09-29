param([switch]$CurrentDirectory, [switch]$ProgramOnly, [switch]$Repair)
$ErrorActionPreference = 'Stop'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('postplus-entry-' + [Guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $temp | Out-Null
  $installer = Join-Path $temp 'install.ps1'
  & curl.exe --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 https://postplus.io/install.ps1 -o $installer
  if ($LASTEXITCODE -ne 0) { throw 'The PostPlus installer could not be downloaded.' }
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
