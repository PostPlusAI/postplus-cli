#!/bin/sh
set -eu
# Installed at <root>/bin/postplus. Never resolve node or npm from PATH.
POSTPLUS_INSTALL_ROOT=$(CDPATH='' cd -P -- "$(dirname -- "$0")/.." && pwd)
fail() { printf '%s\n' 'PostPlus installation is incomplete. Run the official PostPlus installer to repair it.' >&2; exit 1; }
[ -f "$POSTPLUS_INSTALL_ROOT/active" ] || fail
exec 3< "$POSTPLUS_INSTALL_ROOT/active"
IFS= read -r header <&3 || fail
IFS= read -r cli_version <&3 || fail
IFS= read -r node_version <&3 || fail
IFS= read -r node_path <&3 || fail
IFS= read -r cli_path <&3 || fail
IFS= read -r manager_path <&3 || fail
if IFS= read -r extra <&3; then fail; fi
exec 3<&-
[ "$header" = postplus-installation-v1 ] || fail
for path in "$node_path" "$cli_path" "$manager_path"; do
  case "$path" in ''|/*|*[!A-Za-z0-9_./-]*) fail ;; esac
  case "/$path/" in */../*|*/./*|*//*) fail ;; esac
done
case "$node_path" in runtimes/node-v"$node_version"-*/bin/node) ;; *) fail ;; esac
case "$cli_path" in versions/"$cli_version"/*) ;; *) fail ;; esac
case "$manager_path" in versions/"$cli_version"/*) ;; *) fail ;; esac
[ -x "$POSTPLUS_INSTALL_ROOT/$node_path" ] || fail
[ -f "$POSTPLUS_INSTALL_ROOT/$cli_path" ] || fail
unset NODE_OPTIONS NODE_PATH
export POSTPLUS_INSTALL_ROOT
exec "$POSTPLUS_INSTALL_ROOT/$node_path" "$POSTPLUS_INSTALL_ROOT/$cli_path" "$@"
