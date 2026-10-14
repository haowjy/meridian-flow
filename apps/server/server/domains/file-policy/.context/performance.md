# What file permissions cost

Re-measured on the Work-branch foundation, 2026-10-11, with the PR 2 bench
adapted to current bound writes and agent-chain dependencies. Same fixture:
300 manuscript documents in folders up to 6 deep, 100 kb documents, 20 Work
scratch documents, a draft-mode Work, and agent chains of depth 1 and 3.

Statements are counted by postgres.js's `debug` hook, including BEGIN and
COMMIT. Five warmups, one captured operation and two repeated measurements
per row, on an owned migrated throwaway database. The listed rows had identical
counts across repeats; debounced checkpoint and background-overlapping tool
rows are excluded. Shared-machine latency is not a useful comparison.

The [R2 evidence][r2] contains the adapted bench, raw before/after JSON and
query traces. The original experiment remains [PR 2 perf][perf].

## Per operation

| Path | Statements | Of which permissions |
|---|---:|---|
| Live frame, manuscript room (depth 6) | 11 | 3 `confirmEdit` (8 without confirmation) |
| Live frame, Work scratch room (depth 6) | 12 | 3 `confirmEdit` (9 without confirmation) |
| `authorize`, live depth 0 / 3 / 6 | 2 / 3 / 3 | all |
| `authorize`, draft-mode Work (depth 0) | 4 | all |
| `listAccess`, live, 50 / 300 / 1,000 ids | 3 / 3 / 3 | all |
| `listAccess`, draft-mode Work, 420 real ids | 5 | all |
| `readAgentChain`, depth 1 / 3 | 5 / 15 | all |
| `read` tool call, depth 1 / 3 | 47 / 57 | chain 5 / 15, authorize 2, listAccess 2 |
| `ls skills://`, 3 / 10 skills | 7 / 21 | binding + packages, 1 + 2 per skill |
| `skill()`, 3 / 10 skills | 9 / 23 | same |
| Turn assembly, chain depth 1 / 3 | 10 / 18 | lineage permission 2 / 10 |
| Room admission, edit / archived read-only | 19 / 10 | authorize 6 / 4 |
| Reply save, 1 / 5 / 20 documents | 86 / 386 / 1,511 | confirmEdit 7 / 15 / 45 |

## The list regression and its fix

Before R2, `loadList` loaded every document's visible location and folder
chain separately. The tree reader now loads locations for the set, missing
deleted identities when needed, and every folder chain in bulk. File facts
groups differing draft views and asks once per group, not once per row.

| Same list operation | Before | After |
|---|---:|---:|
| Live, 50 ids | 80 | 3 |
| Live, 300 ids | 580 | 3 |
| Live, 1,000 ids (420 real, remainder unknown) | 802 | 3 |
| Draft-mode Work, 420 real ids | 804 | 5 |

No cache is needed: the batched reads stay fresh and constant in statement
count per view. A set containing deleted identities adds one identity read;
different draft views require separate batches.

## What this means

- Frame confirmation adds 3 statements, one more than the old PR 2 numbers.
  Folder depth still costs one bulk chain query, not one query per ancestor.
- Agent chains now cost 5 statements per link. Rebinding must still show on
  the next call, so do not cache that authorization.
- Reply saves cost substantially more than the old PR 2 baseline. Permission
  confirmation is 7 of 86 statements for one document and 45 of 1,511 for
  twenty; most work remains journal, branch and settlement persistence.
- The skill counts did not change. Skill-package reads remain linear.

## Where it went wrong before

- **Skill visibility was quadratic** (215 statements for `ls skills://` with
  10 skills): each skill's check re-read every skill. One binding read now
  serves the call.
- **Concurrent live pulls deadlocked the pool.** A reply writing 12 or more
  documents scheduled pulls that each held a root transaction while the
  live snapshot waited for a second connection; 10 pulls took all 10 pooled
  connections. Pulls now snapshot first, and skip documents with no Work
  draft (a 20-document reply's pulls: 342 → 39 statements). Never acquire a
  pooled connection while holding another on a path that can run many at
  once; [collab TODO][collab-todo] lists the paths that still do.
- **A scratch frame locked its Work twice**, once in `lockSeamWorks` and
  once in `confirmEdit`. The caller now holds the locks.

[perf]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/model-tool-surface/experiments/pr2-perf.md
[collab-todo]: ../../collab/.context/TODO.md

[r2]: https://github.com/haowjy/meridian-flow-docs/tree/main/work/model-tool-surface/impl-foundation/evidence/fix-r2
