# project-tree

The records, the replay, Apply, Discard, Undo and the admission check of the project tree. The
design is `work/project-tree-design/design.md` in the docs repository (sections 2 to 6); this
page says where each part lives and what the code decided where the design left a choice.

## Modules

| File | Holds |
|---|---|
| `record.ts` | Record and settlement types, `source:<id>` roots, the two arrays (`ops`, `settle`) |
| `validate.ts` | `malformedRecord`: whether a value is a record a client may write |
| `view.ts` | `View` (live, or live then one Work), settlements, `viewRecords`, `replayView` |
| `replay.ts` | `replay`: rules 1 to 8, then one pass over the nodes for Trash, kept folders and names |
| `shape.ts` | `childrenOf`, `descendantsOf`, `rankAt`, `fingerprint`, `treeViolations` |
| `writer.ts` | `TreeWriter`: makes records in one copy of the list |
| `apply.ts`, `undo.ts` | Apply, Discard, Undo of a Discard and of an Apply; Undo of one change |
| `admission.ts` | `checkUpdate`, `admit`, `keptCreateRecords` |
| `rows.ts` | `projectedRows`, `branchRows`, `changedRows`: what to write to SQL after a replay |

## The rules

Each is in `replay.ts` and has a named case in `casebook.test.ts`.

1. A move that would put a folder inside itself is skipped (`skipped`, reason `cycle`).
2. A delete takes the node and the nodes its author saw inside it that are still inside it.
3. A node nobody deleted keeps the folders above it standing (`keptByChild`).
4. Two shown siblings with one name both stay; the later arrival shows a number.
5. A drafted record takes effect at its Apply: `viewRecords` replays live, then the Work's.
6. A drafted create whose folder was discarded shows at the top of its `source` (`rescued`).
7. A Work's view keeps a live-deleted node standing while the Work has a pending change to it
   (`keptByPending`; `pendingText` carries documents with pending text, which the list cannot see).
8. A restore brings back the node and what its own delete took; `undoes` lifts one delete alone.

## Decided here, not in the design

- **Sources are `source:<id>` parents, not nodes.** A create carries `source`, the id of the
  source it was made in, so rule 6 and the admission check know it. A record that names a
  source as its node is admitted and refused; a create cannot name one at all.
- **`purge`** marks the node `purged`: later records on it are skipped with reason `purged`, and
  it is in no Trash entry. Descendants are not purged by it; the server purges each node.
- **A refused create is kept by a create the server appends** (`keptCreateRecords`), with
  `replaces` naming the refused record. It goes under the refused record's parent when that is a
  live folder (or a source) the account can write, or was kept earlier in the same update, else
  in the project's Unfiled; it takes the last name the node had in the update. A client cannot
  reuse a node id a refused create holds; only the server's own create does.
- **Admission judges a record in the view it is written in** (live, or live and its Work), so a
  drafted create into a folder drafted in an earlier update is not refused as "not a folder".
- **Undo of an Apply is the simple rule only.** `apply` returns `mark`, the list's state vector
  right after; `undoApply` is `gone` once the state vector moved or text was written in a
  document the Apply created. On the server `mark` is the journal's head.
- **Settlements carry `command`** when a command made them, so Undo of a Discard selects by it
  and a repeat finds nothing left to do.
- **The server's settlement actor is `system`.** Refusals are not any account's act.

## What the server must do

- Keep one `TreeWriter` per copy of the list, under one client id below 1,000, and call
  `admit` under the list's lock after journaling the update.
- Replay live and the views a record can change, then `changedRows` against the last rows.
- Give the writer `pendingText` for views it replays: this package cannot see text.
