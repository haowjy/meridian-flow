#!/usr/bin/env bash
# Create a tmux dev session with backend + frontend panes.
# Session name and ports are derived from the worktree directory — see lib.sh.

set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "$0")/lib.sh"

# Kill existing session if present
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Create new session with backend in left pane
tmux new-session -d -s "$SESSION" -c "$REPO_ROOT/backend" \
  "make run-local PORT=$BACKEND_PORT; exec bash"

# Split horizontally, frontend in right pane
tmux split-window -h -t "$SESSION" -c "$REPO_ROOT/frontend" \
  "pnpm run dev --port $FRONTEND_PORT --host; exec bash"

echo "Dev session '$SESSION' created"
echo "  Backend:  http://localhost:$BACKEND_PORT (left pane)"
echo "  Frontend: http://localhost:$FRONTEND_PORT (right pane)"
echo ""
echo "Attach with: tmux attach -t $SESSION"
