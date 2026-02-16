#!/bin/bash
# Orchestrator — thin wrapper around Go CLI
# Usage: ./scripts/orchestrator/run.sh <plan-file> [flags]
#
# All flags are forwarded to the Go CLI. See the orchestrator module at repo root.
# Env:   AI_TOOL=claude|codex|opencode

REPO_ROOT="$(git rev-parse --show-toplevel)"
exec go run "$REPO_ROOT/orchestrator" "$@"
