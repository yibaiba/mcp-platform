#!/bin/sh
set -eu

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

validate_server() {
  authority=${server#*://}
  case "$authority" in ''|*/*|*\?*|*\#*|*@*) fail 'Server must be an origin URL.' ;; esac
  case "$server" in
    https://*|http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*|http://\[::1\]|http://\[::1\]:*) ;;
    *) fail 'Remote platforms require HTTPS; HTTP is allowed only for loopback development.' ;;
  esac
}

detect_target() {
  case "$(uname -s)" in
    Darwin) target_os=darwin ;;
    Linux) target_os=linux ;;
    *) fail 'This installer supports macOS and Linux. Windows requires install.ps1.' ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) target_arch=amd64 ;;
    arm64|aarch64) target_arch=arm64 ;;
    *) fail 'Unsupported architecture; the connector requires x64 or ARM64.' ;;
  esac
  filename="connector-$target_os-$target_arch"
}

verify_download() {
  expected=$(awk -v name="$filename" '$2 == name {print $1}' "$temporary/SHA256SUMS")
  case "$expected" in ''|*[!0-9a-f]*) fail 'Invalid SHA256SUMS entry.' ;; esac
  [ "${#expected}" -eq 64 ] || fail 'Missing or duplicate SHA256SUMS entry.'
  if command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$temporary/$filename")
  elif command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$temporary/$filename")
  else
    fail 'SHA-256 verification requires shasum or sha256sum.'
  fi
  [ "${actual%% *}" = "$expected" ] || fail 'Connector checksum mismatch; nothing was installed.'
}

install_connector() {
  umask 077
  install_dir=${MCP_PLATFORM_CONNECTOR_HOME:-"$HOME/.local/share/mcp-platform/connector"}
  mkdir -p "$install_dir"
  temporary=$(mktemp -d "$install_dir/.install.XXXXXX")
  trap 'rm -rf "$temporary"' 0
  trap 'exit 1' HUP INT TERM
  curl -fsS --output "$temporary/SHA256SUMS" "$server/api/v1/connector/downloads/SHA256SUMS"
  curl -fsS --output "$temporary/$filename" "$server/api/v1/connector/downloads/$filename"
  verify_download
  chmod 700 "$temporary/$filename"
  mv -f "$temporary/$filename" "$install_dir/connector"
  rm -rf "$temporary"
  trap - 0
  printf 'Connector installed: %s\n' "$install_dir/connector"
}

main() {
  server=''
  install_only=false
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --server) [ "$#" -ge 2 ] || fail '--server requires a URL.'; server=$2; shift 2 ;;
      --install-only) install_only=true; shift ;;
      *) fail "Unknown argument: $1" ;;
    esac
  done
  server=${server%/}
  validate_server
  detect_target
  install_connector
  if [ "$install_only" = true ]; then return; fi
  printf 'Connecting to %s. Paste the pairing code when prompted.\n' "$server"
  exec "$install_dir/connector" connect --server "$server" --config "$install_dir/connector.json"
}

main "$@"
