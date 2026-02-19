#!/usr/bin/env bash
# lib/exec.sh — CLI command building (argv array), execution, files-touched extraction.
# Sourced by run-agent.sh; expects globals from the entrypoint.

# ─── Build CLI Command (argv array) ──────────────────────────────────────────
# Populates global CLI_CMD_ARGV array instead of building a string.
# This avoids eval and shell-injection risks.

build_cli_command() {
  local tool
  tool=$(route_model "$MODEL") || exit 1

  # Pre-flight: verify the CLI binary exists before building the command.
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: '$tool' CLI not found (needed for model $MODEL). Install $tool or try a different model with -m." >&2
    return 1
  fi

  CLI_CMD_ARGV=()
  case "$tool" in
    claude)
      # CLAUDECODE= unsets nested session check (env sets it for the subprocess)
      CLI_CMD_ARGV=(env CLAUDECODE= claude -p - --model "$MODEL" --effort "$EFFORT" --output-format json --allowedTools "$TOOLS" --dangerously-skip-permissions)
      ;;
    codex)
      CLI_CMD_ARGV=(codex exec -m "$MODEL" -c "model_reasoning_effort=$EFFORT" --full-auto --json -)
      ;;
    opencode)
      echo "ERROR: opencode support not yet implemented" >&2
      return 1
      ;;
  esac
}

# Format the argv array as a display string for logging/dry-run output.
format_cli_cmd() {
  local out=""
  for arg in "${CLI_CMD_ARGV[@]}"; do
    if [[ "$arg" == *" "* || "$arg" == *"="* ]]; then
      out+="\"$arg\" "
    else
      out+="$arg "
    fi
  done
  # Trim trailing space
  echo "${out% }"
}

# ─── Files-Touched Extraction ────────────────────────────────────────────────

write_files_touched_from_log() {
  local output_log="$1"
  local touched_file="$2"
  local extractor="$SCRIPT_DIR/extract-files-touched.sh"

  if [[ -x "$extractor" ]]; then
    if ! "$extractor" "$output_log" "$touched_file"; then
      echo "[run-agent] WARNING: files-touched extraction failed" >&2
      echo "# extraction failed" > "$touched_file"
    fi
  else
    : > "$touched_file"
  fi
}

# ─── Dry Run ─────────────────────────────────────────────────────────────────

do_dry_run() {
  local cli_display
  cli_display="$(format_cli_cmd)"

  echo "═══ DRY RUN ═══"
  echo ""
  echo "── Agent: ${AGENT_NAME:-ad-hoc}"
  echo "── Model: $MODEL ($(route_model "$MODEL"))"
  echo "── Effort: $EFFORT"
  echo "── Tools: $TOOLS"
  echo "── Report: $DETAIL"
  if [[ ${#SKILLS[@]} -gt 0 ]]; then echo "── Skills: ${SKILLS[*]}"; else echo "── Skills: none"; fi
  if [[ ${#REF_FILES[@]} -gt 0 ]]; then echo "── Ref files: ${REF_FILES[*]}"; else echo "── Ref files: none"; fi
  echo "── Working dir: $WORK_DIR"
  echo ""
  echo "── CLI Command (argv):"
  echo "  $cli_display"
  echo ""
  echo "── Composed Prompt:"
  echo "────────────────────────────────────────"
  echo "$COMPOSED_PROMPT"
  echo ""
  echo "[report instruction would be appended with LOG_DIR path at $DETAIL detail]"
  echo "────────────────────────────────────────"
}

# ─── Execute ─────────────────────────────────────────────────────────────────

do_execute() {
  local cli_display
  cli_display="$(format_cli_cmd)"

  # Set up logging (always on)
  setup_logging
  write_log_params "$cli_display"

  # Append report instruction now that LOG_DIR is known
  COMPOSED_PROMPT+="$(build_report_instruction "$LOG_DIR/report.md" "$DETAIL")"

  # Save composed prompt
  echo "$COMPOSED_PROMPT" > "$LOG_DIR/input.md"

  echo "[run-agent] Agent: ${AGENT_NAME:-ad-hoc} | Model: $MODEL | Effort: $EFFORT | Log: $LOG_DIR" >&2

  # Execute via argv array — no eval needed
  cd "$WORK_DIR"
  set +e
  "${CLI_CMD_ARGV[@]}" <<< "$COMPOSED_PROMPT" > "$LOG_DIR/output.json" 2>&1
  EXIT_CODE=$?
  set -e

  # Derive touched files from this run's session log.
  write_files_touched_from_log "$LOG_DIR/output.json" "$LOG_DIR/files-touched.txt"

  # Output report to stdout if it was written by the subagent
  if [[ -f "$LOG_DIR/report.md" ]]; then
    cat "$LOG_DIR/report.md"
  fi

  echo "[run-agent] Done (exit=$EXIT_CODE). Log: $LOG_DIR" >&2
  exit $EXIT_CODE
}
