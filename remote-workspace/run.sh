#!/usr/bin/env bash
# Launch the standalone remote-workspace web app.
# Features: file browsing, upload, markdown+mermaid preview.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$SCRIPT_DIR"

PORT="${REMOTE_WS_PORT:-18080}"
SKIP_INSTALL=false
FORCE_INSTALL=false

usage() {
  cat <<EOF_USAGE
Usage: ./remote-workspace/run.sh [options]

Options:
  --port <port>      Listen port (default: REMOTE_WS_PORT or 18080)
  --install          Force dependency install before start
  --skip-install     Skip install check even if node_modules is missing
  --serve            Explicit no-op (serve mode is always enabled)
  -h, --help         Show this help text

Examples:
  ./remote-workspace/run.sh
  ./remote-workspace/run.sh --port 18111
  ./remote-workspace/run.sh --install
  REMOTE_WS_PORT=19000 ./remote-workspace/run.sh
EOF_USAGE
}

require_option_value() {
  local flag_name="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    echo "Missing value for $flag_name." >&2
    exit 1
  fi
}

validate_port() {
  if [[ ! "$PORT" =~ ^[0-9]+$ ]]; then
    echo "Invalid --port value: $PORT (must be numeric)." >&2
    exit 1
  fi
  if (( PORT < 1 || PORT > 65535 )); then
    echo "Invalid --port value: $PORT (must be 1-65535)." >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      shift
      require_option_value "--port" "${1:-}"
      PORT="$1"
      ;;
    --install)
      FORCE_INSTALL=true
      ;;
    --skip-install)
      SKIP_INSTALL=true
      ;;
    --serve)
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

validate_port

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required but not installed." >&2
  exit 1
fi

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale is required (serve mode is always enabled)." >&2
  exit 1
fi
if ! tailscale status >/dev/null 2>&1; then
  echo "tailscale is not connected. Run 'tailscale up' first." >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "remote-workspace app not found at: $APP_DIR" >&2
  exit 1
fi

if [[ "$FORCE_INSTALL" == true ]]; then
  pnpm --dir "$APP_DIR" install
elif [[ "$SKIP_INSTALL" != true && ! -d "$APP_DIR/node_modules" ]]; then
  pnpm --dir "$APP_DIR" install
fi

echo "Configuring tailscale serve (https:443 -> 127.0.0.1:$PORT)"
tailscale serve --bg --https=443 "127.0.0.1:$PORT"
tailscale serve status || true

echo "Starting remote-workspace on http://127.0.0.1:$PORT"
echo "Repo root: $REPO_ROOT"
echo ""

REPO_ROOT="$REPO_ROOT" \
REMOTE_WS_PORT="$PORT" \
pnpm --dir "$APP_DIR" dev
