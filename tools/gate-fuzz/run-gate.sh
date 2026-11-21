#!/usr/bin/env bash
# The gate: each configuration over seeds 0..N-1, two processes at a time (about 300 MB each).
# OUT=<dir> N=10000 ./run-gate.sh, then: node merge.mjs <dir>
set -u
N=${N:-10000}; OUT=${OUT:-/tmp/gate-fuzz-runs}; mkdir -p "$OUT"
cd "$(dirname "$0")"
FORK="$PWD/binding-fork/index.ts"
run() { # name binding args...: one process per configuration
  local name=$1 binding=$2; shift 2
  GATE_BINDING=$binding node --import tsx fuzz.mjs --n "$N" --start 0 "$@" > "$OUT/$name.out" 2>&1
}
run upstream-B loro-prosemirror --approach B & run upstream-A loro-prosemirror --approach A & wait
run fork-B "$FORK" --approach B & run fork-A "$FORK" --approach A & wait
run fork-fixed-B "$FORK" --approach B --undo inverse --reshare & run fork-fixed-A "$FORK" --approach A --undo inverse --reshare & wait
