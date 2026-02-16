#!/bin/bash
# agent.sh — unified AI CLI wrapper
# Usage: source agent.sh; ai_run "prompt" [context_file] [tools] [max_turns]
#
# Supports Claude Code, Codex, and OpenCode via AI_TOOL env var.

: "${AI_TOOL:=claude}"

ai_run() {
  local prompt="$1"
  local context_file="${2:-}"
  local tools="${3:-Read,Edit,Write,Bash,Glob,Grep}"
  local max_turns="${4:-15}"

  case "$AI_TOOL" in
    claude)
      local cmd=(claude -p "$prompt" --output-format json --max-turns "$max_turns" --allowedTools "$tools")
      [[ -n "$context_file" ]] && cmd+=(--append-system-prompt-file "$context_file")
      "${cmd[@]}"
      ;;
    codex)
      # Codex auto-approves all tools, no context file support natively
      # Prepend context file content to prompt if provided
      local full_prompt="$prompt"
      [[ -n "$context_file" ]] && full_prompt="$(cat "$context_file")"$'\n\n'"$prompt"
      codex exec "$full_prompt" --json
      ;;
    opencode)
      local full_prompt="$prompt"
      [[ -n "$context_file" ]] && full_prompt="$(cat "$context_file")"$'\n\n'"$prompt"
      opencode -p "$full_prompt" -f json -q
      ;;
    *)
      echo "Unknown AI_TOOL: $AI_TOOL" >&2
      return 1
      ;;
  esac
}
