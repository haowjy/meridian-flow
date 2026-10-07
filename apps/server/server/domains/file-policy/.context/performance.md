# What file permissions cost

Measured on PR 2 (`feat/model-tool-surface-permissions`, `656580c1b` and the
lock and pull fixes at `2226b125b`), in
statements per operation: postgres.js's `debug` hook, counting every
statement including `BEGIN` and `COMMIT`. Counts are deterministic; latency
on the shared dev machine was noisy, so it isn't recorded here. The bench,
its method and the full tables (with the baseline before the cleanup) are in
the [PR 2 perf experiment][perf]; re-run it after changing any path below.

The project measured: 300 manuscript documents in folders up to 6 deep, a kb
of 100, a Work with 20 scratch documents, a draft-mode Work, and agent
chains of depth 1 and 3.

## Per operation

| Path | Statements | Of which permissions |
|---|---:|---|
| Live frame, manuscript room | 9 | 2 (`confirmEdit`: facts, folder walk) |
| Live frame, Work scratch room | 10 | 2, plus the seam's Work lock |
| `authorize`, any folder depth | 1 or 2 | all (one recursive CTE for folders) |
| `listAccess`, 50 to 1,000 ids | 1 | all |
| `readAgentChain` | 3 per chain link | all |
| `read` tool call (chain depth 1) | about 42 | chain walk 3, `authorize` 1 |
| `ls skills://`, 3 / 10 skills | 7 / 21 | 1 + 2 per skill (`readThreadSkills`) |
| `skill()`, 3 / 10 skills | 9 / 23 | same |
| Turn assembly, chain depth 1 / 3 | 9 / 17 | the lineage walks, 10 of 17 at depth 3 |
| Room admission | 14 (12 read-only) | 2 `authorize` calls |
| Reply save, 1 / 5 / 20 documents | 60 / 268 / 1,048 | `confirmEdit` 5 / 9 / 24 |

## What this means

- **Typing is fine.** Confirmation adds 2 statements to a frame that costs
  7 without it. Skipping it when the grant locks no Work (manuscript, kb,
  user) would save those 2; nothing measured calls for it.
- **Lists and preflights are cheap.** `authorize` and `listAccess` don't
  grow with folder depth or list size in statements. Don't add caching.
- **Agent chains cost per tool call.** Each model tool call re-reads the
  chain (3 statements per link) by design: a `work switch` or rebind must
  show on the next call. Keep it fresh; it is under 10% of a `read`.
- **Reply saves aren't a permission cost.** Confirmation is about 2% of a
  save; the save itself costs about 53 statements per document (journal,
  heads, settlement). Look there first if saves get slow.

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

## Open

- `listAccess` builds facts without folder ancestors, so it can disagree
  with `authorize` once folder grants exist ([TODO](TODO.md)).

[perf]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/model-tool-surface/experiments/pr2-perf.md
[collab-todo]: ../../collab/.context/TODO.md
