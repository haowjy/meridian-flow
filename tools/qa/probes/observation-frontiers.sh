#!/usr/bin/env bash
# Dump observation_frontiers joined to their source turn_blocks.
# Run from a checkout whose DATABASE_URL is already the worktree database
# (direnv, or `eval "$(pnpm exec tsx tools/dev/print-worktree-env.ts)"`).
# Optional $1: a thread UUID, or a room_key prefix (`live:` / `draft:`).
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is not set" >&2
  exit 2
fi

exec python3 - "${1:-}" <<'PY'
import os, sys, urllib.parse, subprocess

filter_arg = sys.argv[1]
u = urllib.parse.urlparse(os.environ["DATABASE_URL"])
env = {
    **os.environ,
    "PGHOST": u.hostname or "127.0.0.1",
    "PGPORT": str(u.port or 5432),
    "PGUSER": u.username or "postgres",
    "PGPASSWORD": u.password or "",
    "PGDATABASE": (u.path or "/").lstrip("/"),
    "PGSSLMODE": "disable",
}


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


where = ""
if filter_arg.startswith("live:") or filter_arg.startswith("draft:"):
    where = f" WHERE of.room_key LIKE {sql_literal(filter_arg + '%')}"
elif filter_arg:
    where = f" WHERE t.thread_id = {sql_literal(filter_arg)}::uuid"

sql = f"""
SELECT
  of.recorded_seq,
  of.source_block_id,
  of.room_key,
  of.unshown,
  length(of.snapshot) AS snap_bytes,
  tb.turn_id,
  t.thread_id,
  left(coalesce(tb.content->>'output', ''), 80) AS output_head
FROM observation_frontiers of
JOIN turn_blocks tb ON tb.id = of.source_block_id
JOIN turns t ON t.id = tb.turn_id
{where}
ORDER BY of.recorded_seq;
"""

subprocess.run(
    [
        "psql", "-w",
        "-h", env["PGHOST"], "-p", env["PGPORT"],
        "-U", env["PGUSER"], "-d", env["PGDATABASE"],
        "-v", "ON_ERROR_STOP=1",
        "-c", sql,
    ],
    env=env,
    check=True,
)
PY
