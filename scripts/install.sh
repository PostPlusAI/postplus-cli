#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'PostPlus CLI install failed: %s\n' "$1" >&2
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js >= 20.10.0 is required before installing PostPlus CLI."
fi

node <<'NODE' || fail "Node.js >= 20.10.0 is required before installing PostPlus CLI."
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 10)) {
  process.exit(1);
}
NODE

if ! command -v npm >/dev/null 2>&1; then
  fail "npm is required to install PostPlus CLI."
fi

npm install -g @postplus/cli

if ! command -v postplus >/dev/null 2>&1; then
  fail "postplus command not found after install. Ensure npm global bin is on your PATH."
fi

postplus help >/dev/null
printf 'PostPlus CLI installed.\n'
