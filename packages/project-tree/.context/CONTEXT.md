# project-tree

The records, the replay, Apply, Discard, Undo and the admission check of the project tree. The
design is `work/project-tree-design/design.md` in the docs repository (sections 2 to 6); this
page says where each part lives and what the code decided where the design left a choice.

## Modules

| File | Holds |
|---|---|
| `record.ts` | Record and settlement types, `source:<id>` roots, the two arrays (`ops`, `settle`) |
| `validate.ts` | `readRecord` (a client's value, for admission) and `readStored` (the server's list, for everything else): each builds the record a value stands for from its own allowed fields, or says why there is none; `writable`, which every record the package writes goes through |
| `names.ts` | `nameFault`, `freeName`: a name's rules and numbering, from the contracts filename codec |
| `list-index.ts` | `listIndex`: record ids, node ids and command ids kept with a copy; `assertNewCommand` |
| `view.ts` | `View` (live, or live then one Work), settlements, `viewValues` and `viewRecords`, `replayView` |
| `replay.ts` | `replay`: rules 1 to 8, then one pass over the nodes for Trash, kept folders and names |
| `shape.ts` | `childrenOf`, `descendantsOf`, `rankAt`, `fingerprint`, `treeViolations` |
| `writer.ts` | `TreeWriter`: makes records in one copy of the list; `moveBetweenLists` |
| `apply.ts`, `undo.ts` | Apply, Discard, restoring a Discard, Undo of an Apply; Undo of one change |
| `admission.ts` | `admit`: the whole-refusal checks, then integrate, judge in list order, append the verdicts |
| `rows.ts` | `projectedRows`, `branchRows`, `changedRows`: what to write to SQL after a replay, with each node's type and extension |

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
  it is in no Trash entry. Descendants are not purged by it; the server purges each node, and
  nothing here checks that it did. A purged node is absent from every view, for placement as for
  display (`placeIn`): a create into it takes rule 6's outcome, a move into it is skipped
  (`missing-parent`), and admission judges it "not a folder".
- **A node can be acted on only if `placeIn` finds it in the view** (its create is in force, and it
  is not purged). The replay skips a record on any other node, Undo answers `superseded` and
  appends nothing, and restoring a Discard leaves the record out and returns it.
- **A refused create is kept by a create the server appends** (`admit` writes it and returns it
  as `kept[].record`), with `replaces` naming the refused record, inserted in the list directly
  after it so the client's later records on the node replay against it. It goes under its parent only when that parent
  is itself a kept create of the same update, else in the project's Unfiled: never under a live
  folder, which would publish what nobody reviewed or the account may not write. It carries the
  refused create's name, type and provisional mark. A client cannot reuse a node id a refused
  create holds; only the server's own create does.
- **Admission judges a record in the view it is written in** (live, or live and its Work), so a
  drafted create into a folder drafted in an earlier update is not refused as "not a folder".
- **Admission judges in list order.** Only the structural checks (the whole refusals) come before
  the update is applied. `admit` then applies it to the server's copy in place, reads where each
  new record landed from the transaction's own change, and judges them in that order: Yjs groups
  an update by client, so a chapter made by one client inside a folder made by another is
  judged after its folder. The verdicts are appended in the same transaction. The copy has
  already changed when the verdicts are made, so a throw means the caller reloads it from the
  journal.
- **Admission rebuilds each record** from its own allowed fields (plain objects and arrays, five
  kinds, a rank in the installed fractional-indexing format exactly (base 62 digits, a head letter that
  fixes the integer part's length, no trailing zero, not the smallest integer: the generator reads a
  character outside the alphabet as `0`, so it cannot be trusted to refuse one), a name the
  contracts codec takes, and a type on every document create) and refuses the update whole otherwise. What the server holds is cut away from each
  struct with Yjs's offset, so an update that overlaps the held prefix, or carries two client
  ids, is admitted; a gap, or content outside `ops`, is not.
- **Undo is by history.** The replay keeps, per node, the record that last set its name and
  type and the record that last set its place, with the values just before it. A move that
  arrives under a numbered name (`name`) is the last setter of both facts, and its Undo needs both:
  the opposite move carries the place and the name before it. Undo of a rename or move is allowed
  only while that record is still the last, and the opposite record carries those values. Apply's copies take their `from` against the copies before them.
- **`carries` says which record a record stands for.** An Apply's live copy and a restored
  Discard's pending copy each carry the root original's id, flattened (a copy of a copy names the
  same root). Undo of R takes back the last record in the view that is R or carries R, and writes
  `undoes` as that record's root, so the replay's setter stack, pending set and Trash entries
  (`from`) all match by the root. If none is in the view (still discarded, applied away,
  superseded), Undo answers `superseded`. Undo of an Apply and `restoreEntry` use the same match.
  `restores`, `restoredBy`, `appliedBy` and `fromDraft` say who and from where, not which record.
- **Whoever makes a record numbers a clash it can see** (`nameAmong`, Apply too); the replay
  numbers only the clashes nobody saw. A move that numbers its arrival carries the name itself,
  not a paired `rename`.
- **A repeated command is the caller's to answer.** The package throws when a command id was
  already used (`assertNewCommand`); the document command table answers a repeat first.
- **A chat's uploads** are a source the account never writes: leave it out of
  `writableSources` and every record on one is refused as a source it cannot change.
- **Undo of an Apply is the simple rule only.** `apply` returns `mark`, the list's state vector
  right after; `undoApply` is `gone` once the state vector moved or text was written in a
  document the Apply created. On the server `mark` is the journal's head. It puts back
  everything its command settled, the superseded records too, and refuses as superseded when a
  record it would restore no longer fits (its node purged, or its folder gone).
- **A Discard is final.** `restoreDiscard` appends fresh pending copies of what the command
  settled, on the branch the caller names (the Work's current one, which may differ from the one the
  Discard closed): new record ids, the same node ids, `carries` naming the
  original, `restores` the Discard and `restoredBy` who restored it (server only; `actor` stays who drafted it). They land after anything drafted since, so the restored change wins on a
  fact both touched; each pending record a copy overrides (same node, same fact: a rename's name
  and type, a move's place; a restore overrides a pending delete; a create or delete overrides
  nothing) is settled discarded under the restoring command, so restoring that command brings it
  back as a copy that wins in turn. Nothing is refused. A copy whose node cannot be acted
  on once the copies are in (purged, or its create is held by another Discard) is left out and
  returned. A Discard restores once (`discardedBy(...).restored`); `discardedBy` lists what a
  Discard settled and the nodes it created, for Trash.
- **Settlements carry `command`** when a command made them, so Undo of an Apply and the restore
  of a Discard select by it.
- **Every read of the list goes through `readStored`.** `replay`, `listRecords` (what `viewRecords`,
  Undo, Apply and the list index read), and admission's positions never touch a decoded object:
  they use the copy built from its own allowed fields, once per decoded object. A value that is
  not a record stays in the list where it stands: `replayView` passes it to `replay`, which
  reports it as `unreadable` in every view, while `listRecords` (the readable records) leaves it out. So the
  server may apply a client's original bytes: whatever reads them reads the rebuilt copy. Cost on
  22,000 records: the first replay of a decoded list is about 120 ms, later ones about 40 ms
  (they read the cached copies).
- **What the package writes it reads back.** Every record it makes (`TreeWriter`, Apply's copies,
  restore copies, kept creates, both halves of `moveBetweenLists`) is built through `writable`,
  which runs `readStored` on it and throws, saying why, when the reader would drop it. A name
  with a `/` or over 255 characters is thrown at the caller, not stored and then lost from every
  view. `freeName` takes the room for a number and the extension from the end of the base, so a
  numbered name stays within the limit.
- **A document's `create` states its `filetype`**, from a client and from the server; a file's
  type is in its blob. The replay never has to guess a document's type.
- **The server's settlement actor is `system`.** Refusals are not any account's act.

## What the server must do

- Put the server's Yjs copy under one client id below 1,000, and call
  `admit` under the list's lock; it changes that copy in place, so reload the copy from the
  journal if anything throws. Write the verdict's `records` that were not refused, and
  `kept[].record` (already in the list), to the journal and the rows.
- Fill `Connection` with `editableTypes`, `sameSchema` and `takenElsewhere`: the package knows no file types or other projects' nodes.
  A rename that fails `sameSchema` is admitted and settled `refused`.
- Move a document between two lists with `moveBetweenLists`, writing both updates in one
  transaction. In the list it left the node is in no view and in no Trash entry.
- Replay live and the views a record can change, then `changedRows` against the last rows.
- Give the writer `pendingText` for views it replays: this package cannot see text.
