# History compaction

A Live room whose rows pass about 5 MB cuts each doc's history on unload, where the doc stood when
its history mark was set at least seven days earlier (`document_snapshots.history_mark`, design §4
"History cutoff"). Before the cut, each fork of the document is forwarded to Live and cut at Live's
marks, and a Live text doc a fork holds ops of that Live lacks is not cut: Apply imports those ops,
which depend on Live's history. Its row keeps its mark and is ripe again a `historyMs` later, so
unloads in between rebuild nothing for it. A fork's row is written by its room's first save, and every save
sets `document_forks.pending`; the retention pass deletes a fork empty for 30 days. This probe runs the real Postgres adapter on a scratch database, with the bounds lowered so
that a small room compacts and a mark ripens in 600 ms.

```sh
pnpm dev:infra   # Postgres
pnpm test:probes history-compaction
```

The script is [`tools/qa/probes/history-compaction/run.mts`](../../../../../../../../tools/qa/probes/history-compaction/run.mts), so `pnpm test:probes` runs it with the
other self-contained probes. It makes and drops its own `lfd_probe_*` database (the model-edit harness's `createScratchDatabase`)
and prints one line per check:

| Check | What it shows |
|---|---|
| The fork's first save writes its row, pending | `writeRows` writes `document_forks` with the fork's first rows |
| An unload past the bounds compacts | `history.compacted` is emitted |
| The second cut shrinks the Live rows | After 150 retypes of one paragraph, the cut at the previous cut's mark makes the rows smaller (about 19 KB down to 13 KB) |
| The text is the same after the cut | Content is unchanged |
| A cut does not move `content_seq` | Derivations don't rerun for a compaction |
| The retyped paragraph's row is a shallow snapshot | A row the cut wouldn't shrink keeps its history and only moves its mark |
| A paragraph a fork wrote ahead of Live keeps Live's history | The fork reworded the opening before Live retyped it 300 times: Live's row for it is not cut |
| An old draft change applies after its Live room compacted | `applyBlocks` on the fork and a commit to Live land the drafted opening (without the hold, `HistoryCutoffError`: probe q11) |
| The fork keeps its own paragraph and imports Live's typing after the cut | A forwarded fork cut at Live's marks still takes Live's batches (review B5) |
| A tab whose base is below the cut is refused | `HistoryCutoffError`, which the socket answers with `history-cutoff` |
| A tab joined after the cut writes | Nothing else is refused |
| The room brings the paragraph back | On the cut rows, the AI's text lands (`commit`) while a tab that never received it deletes the paragraph (`write`): the room's copy holds the one write the removal did not read and restores it (design §1, "Removed blocks", rule 1) |
| The room sends its restore to every socket | A batch with origin `server:restore` |
| The restore is saved | It reads back after an unload |
| A removal that read the AI's text stands | A second delete, made after the restore, is not answered |
| A Discard of every change clears pending | A second draft's fork, pending after a write, reads empty after `discardBlocks` |
| A fork empty for 30 days is deleted with its rows | `retireEmptyForks` reads it again, finds it empty since 40 days and deletes the row; the trigger takes its snapshots |
| A pending fork read again stays, its flag fresh | Its `checked_at` moves, so the next pass does not read it again |

Run it when `collab/rooms/`, fork retention, `shared/document-snapshots.ts` or the removal rule
(`document-model`'s `removals.ts`) changes.
