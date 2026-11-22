# History compaction

A Live room whose rows pass about 5 MB cuts each doc's history on unload, where the doc stood when
its history mark was set at least seven days earlier (`document_snapshots.history_mark`, design §4
"History cutoff"). Before the cut, each fork of the document is forwarded to Live and cut at Live's
marks. This probe runs the real Postgres adapter on a scratch database, with the bounds lowered so
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
| An unload past the bounds compacts | `history.compacted` is emitted |
| The second cut shrinks the Live rows | After 150 retypes of one paragraph, the cut at the previous cut's mark makes the rows smaller (about 19 KB down to 13 KB) |
| The text is the same after the cut | Content is unchanged |
| A cut does not move `content_seq` | Derivations don't rerun for a compaction |
| The retyped paragraph's row is a shallow snapshot | A row the cut wouldn't shrink keeps its history and only moves its mark |
| The fork keeps its own paragraph and imports Live's typing after the cut | A forwarded fork cut at Live's marks still takes Live's batches (review B5) |
| A tab whose base is below the cut is refused | `HistoryCutoffError`, which the socket answers with `history-cutoff` |
| A tab joined after the cut writes | Nothing else is refused |

Run it when `collab/rooms/` or `shared/document-snapshots.ts` changes.
