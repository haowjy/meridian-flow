#!/usr/bin/env bash
# Reliably restart the backend dev server via tmux respawn-pane.
# Uses respawn-pane -k which kills the process and starts fresh — much more
# reliable than sending ctrl+c.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION="ms_server"

# Load port overrides if present
BACKEND_PORT=8080
if [[ -f "$REPO_ROOT/.dev-ports" ]]; then
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.dev-ports"
fi

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "ERROR: tmux session '$SESSION' not found. Run scripts/dev/setup.sh first." >&2
  exit 1
fi

tmux respawn-pane -k -t "$SESSION:0.0" \
  "cd $REPO_ROOT/backend && PORT=$BACKEND_PORT make run-local; exec bash"

echo "Backend restarted on :$BACKEND_PORT"
