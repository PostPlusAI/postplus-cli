$ErrorActionPreference = 'Stop'

function Fail($Message) {
  Write-Error "PostPlus CLI install failed: $Message"
  exit 1
}

try {
  $nodeVersionText = (& node -p "process.versions.node") 2>$null
  if (-not $nodeVersionText) {
    Fail "Node.js >= 20.10.0 is required before installing PostPlus CLI."
  }

  $nodeVersion = [Version]$nodeVersionText
  if ($nodeVersion.Major -lt 20 -or ($nodeVersion.Major -eq 20 -and $nodeVersion.Minor -lt 10)) {
    Fail "Node.js >= 20.10.0 is required before installing PostPlus CLI."
  }

  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "npm is required to install PostPlus CLI."
  }

  & npm install -g @postplus/cli

  if (-not (Get-Command postplus -ErrorAction SilentlyContinue)) {
    Fail "postplus command not found after install. Ensure npm global bin is on your PATH."
  }

  & postplus help | Out-Null
  Write-Output "PostPlus CLI installed."
} catch {
  Fail $_.Exception.Message
}
