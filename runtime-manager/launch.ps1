$ErrorActionPreference = 'Stop'
try {
  $installRoot = Split-Path -Parent $PSScriptRoot
  $lines = [IO.File]::ReadAllLines((Join-Path $installRoot 'active'))
  if ($lines.Length -ne 6 -or $lines[0] -ne 'postplus-installation-v1') { throw 'Invalid installation record.' }
  $cliVersion, $nodeVersion, $nodePath, $cliPath, $managerPath = $lines[1..5]
  foreach ($path in @($nodePath, $cliPath, $managerPath)) {
    if ($path -notmatch '^[A-Za-z0-9_./-]+$' -or [IO.Path]::IsPathRooted($path) -or
        ($path.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' })) { throw 'Invalid installation path.' }
  }
  if (-not $nodePath.StartsWith("runtimes/node-v$nodeVersion-") -or
      -not $nodePath.EndsWith('/node.exe') -or
      -not $cliPath.StartsWith("versions/$cliVersion/") -or
      -not $managerPath.StartsWith("versions/$cliVersion/")) { throw 'Installation versions do not match.' }
  $node = Join-Path $installRoot $nodePath
  $cli = Join-Path $installRoot $cliPath
  if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Installation files are missing.' }
  $env:POSTPLUS_INSTALL_ROOT = $installRoot
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
  # Windows PowerShell 5.1's native invocation drops empty arguments and
  # changes embedded quotes. Quote for the Windows process API explicitly.
  function Quote-NativeArgument([string]$value) {
    $escaped = [regex]::Replace($value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
  }
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $node
  $startInfo.UseShellExecute = $false
  $startInfo.WorkingDirectory = (Get-Location).ProviderPath
  $startInfo.Arguments = (@($cli) + @($args) | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
  $child = [Diagnostics.Process]::Start($startInfo)
  $child.WaitForExit()
  $status = $child.ExitCode
  $child.Dispose()
  exit $status
} catch {
  [Console]::Error.WriteLine('PostPlus installation is incomplete. Run the official PostPlus installer to repair it.')
  exit 1
}
