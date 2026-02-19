#!/usr/bin/env bash
# Restart the backend dev server.
# Delegates to scripts/dev/restart-backend.sh for the reliable tmux respawn approach.
exec "$(dirname "$0")/dev/restart-backend.sh" "$@"
