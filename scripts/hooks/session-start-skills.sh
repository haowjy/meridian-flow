#!/usr/bin/env bash
# session-start-skills.sh — SessionStart hook
#
# On clear/startup/resume, scans the previous conversation transcript for
# skill activations. For each detected skill, injects additionalContext
# telling Claude to autoload it in the new session.
#
# Detection is based on actual activation signals in the transcript, not
# just mentions. This catches both user-initiated (/skill) and LLM-initiated
# (Skill tool) activations.
#
# EXTENSIBILITY: To add more skills, just append to TRACKED_SKILLS below.
#
# Input: JSON on stdin with { transcript_path, source, cwd, ... }
# Output: JSON with additionalContext on stdout (exit 0)

set -euo pipefail

# ============================================================================
# CONFIGURATION — add skill names here to auto-detect and reload them
# ============================================================================
TRACKED_SKILLS=(
  "orchestrate"
  "run-agent"
)

# ============================================================================
# Parse hook input
# ============================================================================
INPUT=$(cat)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
SOURCE=$(echo "$INPUT" | jq -r '.source // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Only fire on clear/startup/resume — skip compact
case "$SOURCE" in
  clear|startup|resume) ;;
  *) exit 0 ;;
esac

# Need a transcript to scan
if [[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]]; then
  exit 0
fi

# ============================================================================
# Detect which tracked skills were actually activated in the previous session
# ============================================================================
DETECTED_SKILLS=()

for skill in "${TRACKED_SKILLS[@]}"; do
  # Detection signals (ordered by reliability):
  #
  # 1. "Launching skill: <name>" — tool result confirming the skill was loaded.
  #    This is the definitive activation marker, present for both user-initiated
  #    (/skill) and LLM-initiated (Skill tool) activations.
  #
  # 2. "Base directory for this skill: .../skills/<name>" — the isMeta message
  #    that injects the SKILL.md content. Confirms the skill instructions were
  #    actually loaded into context.
  #
  # 3. "name":"Skill" + "skill":"<name>" — the Skill tool invocation itself.
  #    May appear even if activation failed, but useful as a fallback signal.
  #
  # We check all three to be robust against transcript format variations.

  if grep -qF "Launching skill: ${skill}" "$TRANSCRIPT_PATH" 2>/dev/null; then
    DETECTED_SKILLS+=("$skill")
  elif grep -q "Base directory for this skill:.*skills/${skill}" "$TRANSCRIPT_PATH" 2>/dev/null; then
    DETECTED_SKILLS+=("$skill")
  elif grep -qE "\"name\":\s*\"Skill\"" "$TRANSCRIPT_PATH" 2>/dev/null && \
       grep -qE "\"skill\":\s*\"${skill}\"" "$TRANSCRIPT_PATH" 2>/dev/null; then
    DETECTED_SKILLS+=("$skill")
  fi
done

if [[ ${#DETECTED_SKILLS[@]} -eq 0 ]]; then
  exit 0
fi

# ============================================================================
# Check for active orchestration session (non-complete) as extra context
# ============================================================================
ACTIVE_PLAN=""
SESSION_DIR="$CWD/.claude/skills/orchestrate/.session"
if [[ -d "$SESSION_DIR/plans" ]]; then
  while IFS= read -r handoff; do
    if [[ -f "$handoff" ]] && ! grep -q "PLAN COMPLETE" "$handoff" 2>/dev/null; then
      ACTIVE_PLAN=$(echo "$handoff" | sed "s|$SESSION_DIR/plans/||" | sed 's|/handoffs/.*||')
      break
    fi
  done < <(find "$SESSION_DIR/plans" -name "latest.md" -type f 2>/dev/null | sort -r)
fi

# ============================================================================
# Build additionalContext
# ============================================================================
LINES=()
LINES+=("**Auto-detected skills from previous session — load these before proceeding:**")
for skill in "${DETECTED_SKILLS[@]}"; do
  LINES+=("- \`/$skill\` was active in the previous conversation. Load it now with the Skill tool.")
done

if [[ -n "$ACTIVE_PLAN" ]]; then
  LINES+=("")
  LINES+=("**Active orchestration plan:** \`$ACTIVE_PLAN\` (not yet complete). Check handoff at \`.claude/skills/orchestrate/.session/plans/$ACTIVE_PLAN/handoffs/latest.md\`.")
fi

# Join lines
CONTEXT=""
for line in "${LINES[@]}"; do
  CONTEXT+="$line\n"
done

jq -n --arg ctx "$(echo -e "$CONTEXT")" '{ "additionalContext": $ctx }'
