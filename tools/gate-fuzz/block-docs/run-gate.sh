#!/usr/bin/env bash
set -eu
cd "$(dirname "$0")"
OUT=${OUT:-/tmp/p18924-block-docs-gate}
N=${N:-10000}
mkdir -p "$OUT"
FIRST=$((N / 2))
SECOND=$((N - FIRST))
BINDING="$PWD/../binding-fork/index.ts"
GATE_BINDING="$BINDING" node --import tsx fuzz.mjs --start 0 --n "$FIRST" > "$OUT/first.txt" 2>&1 &
p1=$!
GATE_BINDING="$BINDING" node --import tsx fuzz.mjs --start "$FIRST" --n "$SECOND" > "$OUT/second.txt" 2>&1 &
p2=$!
status=0
wait "$p1" || status=1
wait "$p2" || status=1
cat "$OUT/first.txt" "$OUT/second.txt"
exit "$status"
