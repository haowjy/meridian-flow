#!/usr/bin/env bash
# Dump observation_frontiers joined to their source turn_blocks.
# Run from the repo root of the checkout to read; queries go through `tools/dev/psql`.
# Optional $1: a thread UUID, or a room_key prefix (`live:` / `draft:`).
set -euo pipefail

exec python3 - "${1:-}" <<'PY'
import sys, subprocess

filter_arg = sys.argv[1]


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
  of.journal_position,
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
    ["tools/dev/psql", "-v", "ON_ERROR_STOP=1", "-c", sql],
    check=True,
)
PY
