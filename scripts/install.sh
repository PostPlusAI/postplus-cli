#!/bin/sh
set -eu
# The generated official installer owns platform and runtime selection.
# This repository/archive entry needs curl and a shell, never Node or npm.
temp=$(mktemp -d "${TMPDIR:-/tmp}/postplus-entry.XXXXXXXX")
trap 'rm -rf "$temp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
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
    diagnostic "$code" "$next"; exit "$code"
  fi
}
platform=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
download https://postplus.io/install.sh "$temp/install.sh" installer unknown
/bin/sh "$temp/install.sh" "$@"
