# Frontier survives compaction

A frontier is a Yjs snapshot (`Y.encodeSnapshotV2(Y.snapshot(room))`) recorded next to a
model's tool result. This probe pins the Yjs behaviour the store's gc-off contract depends on:
a snapshot restores from the fold of a `gc: false` doc, and fails or restores wrong text
otherwise. It builds its own `Y.Doc`s and imports nothing from the repo, so it does not
exercise the server. It cannot catch a fold that starts encoding a gc-on doc; the contract
holds by construction (every server doc is `gc: false`). It needs no database, dev stack or
browser.

```bash
pnpm exec tsx tools/qa/probes/frontier-survives-compaction/run.mts
```

It prints one `PASS` or `FAIL` per check and exits with the number that failed.

| Check | What it shows |
|---|---|
| Snapshot restores from the folded origin | A snapshot taken mid-history (with deletes), then a fold (`Y.encodeStateAsUpdate` of the `gc: false` room) and more writes: `Y.createDocFromSnapshot` on the folded origin gives the text at the snapshot. The fold keeps every struct the snapshot's clocks name. |
| A `gc: true` origin throws | `Garbage-collection must be disabled in \`originDoc\`!` A client doc can never be the origin. |
| A once-collected store restores wrong text silently | Encoding a doc that already collected its deleted items, then loading it into a `gc: false` doc, restores without throwing but with missing content. A `gc: false` flag set after the fact does not repair it. |
| Containment accepts the compacted room, refuses a re-fork | Every client in the snapshot's state vector must be in the origin with a clock at least as high. |
| `snapshotContainsUpdate` fails on a valid compacted room | `Y.snapshotContainsUpdate(S, encodeStateAsUpdate(origin))` asks the opposite question (does the snapshot hold all of the origin?) and answers false once the room has written past the snapshot. That is why the contract uses state-vector containment. |

A `FAIL` means Yjs changed one of these behaviours. Restore into a view doc created with
`{ gc: false }` too, because `createDocFromSnapshot` defaults to gc on. The collab
[AGENTS.md](../../apps/server/server/domains/collab/AGENTS.md) holds the contract.

The numbers and design behind it are in the
[proof of concept record](https://github.com/haowjy/meridian-flow-docs/blob/main/work/diff-based-review/design/joint/poc-frontier-compaction.md).
