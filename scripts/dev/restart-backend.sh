#!/usr/bin/env bash
# Reliably restart the backend dev server via tmux respawn-pane.
# Uses respawn-pane -k which kills the process and starts fresh — much more
# reliable than sending ctrl+c.

set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "ERROR: tmux session '$SESSION' not found. Run scripts/dev/setup.sh first." >&2
  exit 1
fi

tmux respawn-pane -k -t "$SESSION:0.0" \
  "cd $REPO_ROOT/backend && PORT=$BACKEND_PORT make run-local; exec bash"

echo "Backend restarted on :$BACKEND_PORT"
