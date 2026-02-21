#!/usr/bin/env bash
# plan-mode-skills.sh — PreToolUse hook for EnterPlanMode
#
# When Claude enters plan mode, inject a reminder to load the mermaid skill.
# Design docs and plans must use Mermaid diagrams per CLAUDE.md.
#
# Input: JSON on stdin with tool_name, tool_input, etc.
# Output: JSON with additionalContext on stdout

set -euo pipefail

jq -n '{
  "additionalContext": "You are entering plan mode. Load the `mermaid` skill now (use the Skill tool with skill: \"mermaid\") — design docs and plans MUST use Mermaid diagrams for data flows, architecture, and state transitions."
}'
