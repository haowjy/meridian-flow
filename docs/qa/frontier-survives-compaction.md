# Frontier survives compaction

A frontier is a Yjs snapshot (`Y.encodeSnapshotV2(Y.snapshot(room))`) recorded next to a
model's tool result. This probe shows that the branch store's compaction fold keeps it
restorable, and where it stops working. It needs no database, dev stack or browser.

```bash
pnpm exec tsx tools/qa/probes/frontier-survives-compaction/run.mts
```

It prints one `PASS` or `FAIL` per check and exits with the number that failed.

| Check | What it shows |
|---|---|
| Snapshot restores from the folded origin | A snapshot taken mid-history (with deletes), then a fold (`Y.encodeStateAsUpdate` of the `gc: false` room) and more writes: `Y.createDocFromSnapshot` on the folded origin gives the text at the snapshot. The fold keeps every struct the snapshot's clocks name. |
| A `gc: true` origin throws | `Garbage-collection must be disabled in \`originDoc\`!` A client doc can never be the origin. |
| A once-collected store restores wrong text silently | Encoding a doc that already collected its deleted items, then loading it into a `gc: false` doc, restores without throwing but with missing content. A `gc: false` flag set after the fact does not repair it. |
| Containment accepts the compacted room, refuses a re-fork | Every client in the snapshot's state vector must be in the origin with a clock at least as high. `Y.snapshotContainsUpdate(S, encodeStateAsUpdate(origin))` asks the opposite question and fails on a valid compacted room. |

It passes when the store keeps its gc-off contract (see the collab
[AGENTS.md](../../apps/server/server/domains/collab/AGENTS.md)). A `FAIL` on the first
check means a fold or materialization began to encode a gc-on doc. Restore into a view doc
created with `{ gc: false }` too, because `createDocFromSnapshot` defaults to gc on.

Evidence: a first run measured a snapshot at 447 bytes after 200 frames and 1.5 KB for a
50,000-word document rewritten five times (restore 14 ms, 7 MB heap). Run it again at the
commit under test and record the commit, date and outcome.
