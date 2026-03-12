#!/usr/bin/env bash
# Create a tmux dev session with backend + frontend panes.
# Session name and ports are derived from the worktree directory — see lib.sh.

set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"

# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

# ── Optional: start local Supabase if available ───────────────────────────

if command -v supabase &>/dev/null && command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  # Check if Supabase is already running
  if ! (cd "$REPO_ROOT/backend" && supabase status &>/dev/null 2>&1); then
    echo "Starting local Supabase..."
    "$SCRIPT_DIR/supabase-start.sh"
  else
    echo "Local Supabase already running"
  fi
else
  echo "Skipping local Supabase (missing docker or supabase CLI)"
fi

# ── tmux session ──────────────────────────────────────────────────────────

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
