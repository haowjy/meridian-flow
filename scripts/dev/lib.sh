#!/usr/bin/env bash
# Shared config for dev scripts.
# Sources per-worktree session name and port offsets.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Session name = directory basename (worktree-safe)
SESSION="$(basename "$REPO_ROOT" | tr '/' '_')"

# Backend gets deterministic port offset per worktree; frontend always 3000
OFFSET=$(printf '%s' "$SESSION" | cksum | awk '{print $1 % 100}')
BACKEND_PORT=$((8080 + OFFSET))
FRONTEND_PORT=3000

# Per-worktree overrides (optional .dev-ports in repo root)
if [[ -f "$REPO_ROOT/.dev-ports" ]]; then
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.dev-ports"
fi
