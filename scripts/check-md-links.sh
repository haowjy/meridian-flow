#!/usr/bin/env bash
# Delegates to .claude/skills/documenting/check-md-links.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$REPO_ROOT/.claude/skills/documenting/check-md-links.sh" "$@"
