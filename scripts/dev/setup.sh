#!/usr/bin/env bash
# Create a tmux dev session with backend + frontend panes.
# Reads optional .dev-ports for per-worktree port overrides.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SESSION="ms_server"

# Load port overrides if present
BACKEND_PORT=8080
FRONTEND_PORT=5173
if [[ -f "$REPO_ROOT/.dev-ports" ]]; then
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.dev-ports"
fi

# Kill existing session if present
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Create new session with backend in left pane
tmux new-session -d -s "$SESSION" -c "$REPO_ROOT/backend" \
  "PORT=$BACKEND_PORT make run-local; exec bash"

# Split horizontally, frontend in right pane
tmux split-window -h -t "$SESSION" -c "$REPO_ROOT/frontend" \
  "pnpm run dev --port $FRONTEND_PORT; exec bash"

echo "Dev session '$SESSION' created"
echo "  Backend:  http://localhost:$BACKEND_PORT (left pane)"
echo "  Frontend: http://localhost:$FRONTEND_PORT (right pane)"
echo ""
echo "Attach with: tmux attach -t $SESSION"
