#!/bin/sh
set -eu
# The generated official installer owns platform and runtime selection.
# This repository/archive entry needs curl and a shell, never Node or npm.
temp=$(mktemp -d "${TMPDIR:-/tmp}/postplus-entry.XXXXXXXX")
trap 'rm -rf "$temp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 https://postplus.io/install.sh -o "$temp/install.sh"
/bin/sh "$temp/install.sh" "$@"
