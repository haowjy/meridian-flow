#!/usr/bin/env bash
# Thin wrapper — delegates to the mermaid skill's script.
# Usage: ./scripts/check-mermaid.sh [file.md|directory...]
exec "$(dirname "$0")/../.claude/skills/mermaid/scripts/check-mermaid.sh" "$@"
