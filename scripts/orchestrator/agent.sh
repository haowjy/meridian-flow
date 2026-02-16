#!/bin/bash
# agent.sh — unified AI CLI wrapper
# Usage: source agent.sh; ai_run "prompt" [context_file] [tools] [max_turns]
#
# Supports Claude Code, Codex, and OpenCode via AI_TOOL env var.
# Prompts are passed via temp files/stdin to avoid ARG_MAX and quoting issues.

: "${AI_TOOL:=claude}"

ai_run() {
  local prompt="$1"
  local context_file="${2:-}"
  local tools="${3:-Read,Edit,Write,Bash,Glob,Grep}"
  local max_turns="${4:-15}"

  # Write prompt to temp file to avoid ARG_MAX and quoting issues
  local prompt_file
  prompt_file=$(mktemp)
  printf '%s' "$prompt" > "$prompt_file"
  trap "rm -f '$prompt_file'" RETURN

  case "$AI_TOOL" in
    claude)
      local cmd=(claude -p - --output-format json --max-turns "$max_turns" --allowedTools "$tools")
      [[ -n "$context_file" ]] && cmd+=(--append-system-prompt-file "$context_file")
      "${cmd[@]}" < "$prompt_file"
      ;;
    codex)
      # Codex auto-approves all tools, no context file support natively
      # Prepend context file content to prompt if provided
      local full_file
      full_file=$(mktemp)
      if [[ -n "$context_file" ]]; then
        cat "$context_file" > "$full_file"
        printf '\n\n' >> "$full_file"
      fi
      cat "$prompt_file" >> "$full_file"
      codex exec "$(cat "$full_file")" --json
      rm -f "$full_file"
      ;;
    opencode)
      local full_file
      full_file=$(mktemp)
      if [[ -n "$context_file" ]]; then
        cat "$context_file" > "$full_file"
        printf '\n\n' >> "$full_file"
      fi
      cat "$prompt_file" >> "$full_file"
      opencode -p "$(cat "$full_file")" -f json -q
      rm -f "$full_file"
      ;;
    *)
      echo "Unknown AI_TOOL: $AI_TOOL" >&2
      return 1
      ;;
  esac
}
