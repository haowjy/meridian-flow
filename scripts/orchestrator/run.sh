#!/bin/bash
set -euo pipefail

# Orchestrator — automated plan-to-commit pipeline
# Usage: ./scripts/orchestrator/run.sh <plan-file>
# Env:   AI_TOOL=claude|codex|opencode  MAX_SLICES=20

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
PLAN_FILE="${1:?Usage: run.sh <plan-file>}"
TASKS_DIR="$REPO_ROOT/_docs/hidden/tasks"
LOG_DIR="$REPO_ROOT/_docs/hidden/orchestrator-logs"
PROMPTS_DIR="$SCRIPT_DIR/prompts"
MAX_SLICES="${MAX_SLICES:-20}"

source "$SCRIPT_DIR/agent.sh"
mkdir -p "$TASKS_DIR" "$LOG_DIR"

log() { echo "[$(date +%H:%M:%S)] $1"; }

# Template substitution — replaces {{KEY}} with value using sed
# Handles multi-line values, special characters in replacements safely
render() {
  local template="$1"; shift
  local rendered
  rendered=$(mktemp)
  cp "$PROMPTS_DIR/$template" "$rendered"
  while [[ $# -gt 0 ]]; do
    local key="$1" val="$2"; shift 2
    # Use awk for safe multi-line substitution (sed can't handle newlines in replacement)
    awk -v pat="{{${key}}}" -v rep="$val" '{
      idx = index($0, pat)
      while (idx > 0) {
        $0 = substr($0, 1, idx-1) rep substr($0, idx+length(pat))
        idx = index($0, pat)
      }
      print
    }' "$rendered" > "${rendered}.tmp" && mv "${rendered}.tmp" "$rendered"
  done
  cat "$rendered"
  rm -f "$rendered"
}

slice=0
while [ $slice -lt $MAX_SLICES ]; do
  slice=$((slice + 1))

  # ── PLAN SLICE ──
  log "=== PLAN SLICE $slice ==="
  prompt=$(render plan-slice.md \
    PLAN_FILE "$PLAN_FILE" \
    TASKS_DIR "$TASKS_DIR")

  ai_run "$prompt" "$REPO_ROOT/CLAUDE.md" "Read,Edit,Write,Glob,Grep" 10 \
    > "$LOG_DIR/slice-${slice}-plan.json" 2>&1 || true

  # Check if all slices are done
  if [[ -f "$TASKS_DIR/current.md" ]] && grep -q "ALL_DONE" "$TASKS_DIR/current.md"; then
    log "All slices complete!"
    break
  fi

  # Guard: skip implement/review/commit if plan-slice failed to produce a task
  if [[ ! -s "$TASKS_DIR/current.md" ]]; then
    log "WARNING: No current.md produced by plan-slice stage — skipping implement/review/commit"
    continue
  fi

  # ── IMPLEMENT ──
  log "=== IMPLEMENT (slice $slice) ==="
  prompt=$(render implement.md TASKS_DIR "$TASKS_DIR")

  ai_run "$prompt" "$REPO_ROOT/CLAUDE.md" "Read,Edit,Write,Bash,Glob,Grep" 25 \
    > "$LOG_DIR/slice-${slice}-implement.json" 2>&1 || true

  # ── REVIEW ──
  log "=== REVIEW (slice $slice) ==="
  prompt=$(render review.md TASKS_DIR "$TASKS_DIR")

  ai_run "$prompt" "$REPO_ROOT/CLAUDE.md" "Read,Edit,Write,Bash,Glob,Grep" 15 \
    > "$LOG_DIR/slice-${slice}-review.json" 2>&1 || true

  # ── CLEANUP LOOP ──
  for cleanup_file in "$TASKS_DIR"/cleanup-*.md; do
    [[ -f "$cleanup_file" ]] || continue
    log "=== CLEANUP: $(basename "$cleanup_file") ==="
    prompt=$(render cleanup.md CLEANUP_FILE "$cleanup_file")

    ai_run "$prompt" "$REPO_ROOT/CLAUDE.md" "Read,Edit,Write,Bash,Glob,Grep" 10 \
      > "$LOG_DIR/slice-${slice}-$(basename "$cleanup_file" .md).json" 2>&1 || true
  done

  # ── COMMIT ──
  log "=== COMMIT (slice $slice) ==="
  breadcrumbs=""
  for f in "$TASKS_DIR"/*.md; do
    [[ -f "$f" ]] && breadcrumbs="${breadcrumbs}"$'\n'"- ${f}"
  done
  prompt=$(render commit.md BREADCRUMBS "$breadcrumbs")

  # Use "Bash" (not "Bash(git *)") — prompt constrains to git-only operations
  ai_run "$prompt" "$REPO_ROOT/CLAUDE.md" "Bash,Read,Glob,Grep" 5 \
    > "$LOG_DIR/slice-${slice}-commit.json" 2>&1 || true

  # ── ROTATE TASK FILES ──
  cat "$TASKS_DIR/current.md" >> "$TASKS_DIR/progress.md" 2>/dev/null || true
  printf '\n---\n\n' >> "$TASKS_DIR/progress.md" 2>/dev/null || true
  rm -f "$TASKS_DIR"/current.md "$TASKS_DIR"/cleanup-*.md

  log "Slice $slice complete."
done

# Final cleanup
log "=== DONE ==="
rm -f "$TASKS_DIR/progress.md"
log "Logs: $LOG_DIR/"
