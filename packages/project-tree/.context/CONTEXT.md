# project-tree

The records, the replay, Apply, Discard, Undo and the guard on what a client sends of the project tree. The
design is `work/project-tree-design/design.md` in the docs repository (sections 2 to 6); this
page says where each part lives and what the code decided where the design left a choice.

## Modules

| File | Holds |
|---|---|
| `record.ts` | Record and settlement types, `source:<id>` roots, the two arrays (`ops`, `settle`) |
| `validate.ts` | `readStored` (every read of the list) builds the record a value stands for from its own allowed fields, or says why there is none; `writable`, which every record the package writes goes through; which fields are the server's |
| `names.ts` | `shownName` (the replay's name for a node of a kind: `normalEntryName`), `freeName`: numbering, from the contracts filename codec |
| `list-index.ts` | `listIndex`: record ids, node ids and command ids kept with a copy; `assertNewCommand` |
| `view.ts` | `View` (live, or live then one Work), settlements, `viewValues` and `viewRecords`, `replayView` |
| `replay.ts` | `replay`: rules 1 to 13, then one pass over the nodes for Trash, kept folders and names |
| `shape.ts` | `childrenOf`, `descendantsOf`, `rankAt`, `fingerprint`, `treeViolations` |
| `writer.ts` | `TreeWriter`: makes records in one copy of the list; `moveBetweenLists` |
| `apply.ts`, `undo.ts` | Apply, Discard, restoring a Discard, Undo of an Apply; Undo of one change |
| `admission.ts` | `guard` (the faults that close a copy), `clientMayWrite`, `admit`: guard, integrate, stamp `dropped` |
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
9. A move or rename of a node in Trash restores it (a record with `undoes` never does). A live
   record lifts live deletes by list order; a drafted record lifts only its Work's own, so rule 7
   still holds in a Work's view.
10. A purge is final wherever it sits in the list: no later restore, and no record placed after
    it by Yjs, brings the node back. It takes exactly the nodes it names (`nodes`, what the server
    found its delete covering and released); any other node standing under a purged one at the
    end of the replay goes to the top of its source, arriving there at that purge.
11. A document create or rename to a type that is not a tracked document is skipped
    (`type-not-editable`).
12. A rename to a type of another Yjs schema is skipped (`type-across-schemas`).
13. A name is `normalEntryName(kind, typed)` for the node's kind, in every create, rename and
    move; nothing is refused for its name.

Rules 11 to 13 read `classifyFiletype`, `schemaType` and `normalEntryName`, which are frozen as
the replay uses them (package `AGENTS.md`).

## Decided here, not in the design

- **Sources are `source:<id>` parents, not nodes.** A create carries `source`, the id of the
  source it was made in, so rule 6 and the admission check know it. A record that names a
  source as its node is skipped (`missing-node`); a create cannot name one at all.
- **`purge`** marks the nodes it names `purged`: later records on them are skipped with reason
  `purged`, and they are in no Trash entry. Its `nodes` is a server-only field, so the guard
  covers it, and the release set, the rows and every replay read that one set: no replay works out
  coverage again from cascades that later records changed. A purged node is absent from every view, for placement as for
  display (`placeIn`): a create into it takes rule 6's outcome and a move into it is skipped
  (`missing-parent`).
- **A node can be acted on only if `placeIn` finds it in the view** (its create is in force, and it
  is not purged). The replay skips a record on any other node, Undo answers `purged` and
  appends nothing, and restoring a Discard leaves the record out and returns it.
- **Nothing is refused for what it says.** A client's record that the replay cannot place
  (a node that is not there, a folder inside itself, a name already taken) is skipped or numbered
  by the rules, the same in every replay; the writer keeps it in the list. The server writes one
  verdict, `dropped` (admission, below).
- **`guard` closes a copy that does what an honest client never does**: a deletion, content
  outside `ops`, a struct whose position cannot be decided (a gap in a writer's own clock, a
  pending struct), a client id below 1,000, a record kind or field only the server writes
  (`clientMayWrite`: `purge`, a file create, `carries`, `blob`, `list:` parents), more than
  `MAX_RECORDS` records. It throws `CopyFault`; nothing is stored, and the room closes the
  connection with the one terminal code. Names, sources, drafts and types are not its business.
- **`admit` stamps `dropped`** (`Admission.dropped`, settled by `system`, reason "Work was
  closed") on a create whose draft is not open, whose source is a closed Work's, or that is
  made inside a dropped node. The server's arrival order is the only true order of "raced the
  close", so this one verdict is the server's. The replay needs no rule: `viewValues` leaves a
  settled drafted record out and filters `dropped` in the live branch. The projection's `dropped`
  list comes from the settle log; a dropped create stays dropped after the Work is restored.
  `Connection` is `{ drafts, closedSources }`.
- **Parts of one client's offline history** arrive in causal order and are admitted in order
  (the room queues a connection's messages); an honest client's parts are never a fault.
- **Undo is by history.** The replay keeps, per node, the record that last set its name and
  type and the record that last set its place, with the values just before it. A move that
  arrives under a numbered name (`name`) is the last setter of both facts, and its Undo needs both:
  the opposite move carries the place and the name before it. Undo of a rename or move is allowed
  only while that record is still the last, and the opposite record carries those values. Apply's copies take their `from` against the copies before them.
  Undo of a delete is allowed while that delete is a Trash entry in force. The opposite record of a
  restore puts back the deletes that restore lifted, under their own ids, with what each took (the
  replay keeps what each restore lifted): the entry is the original delete again, so its Undo and
  `restoreEntry` reach it, and a restore that takes that Undo back lifts them again. That
  opposite delete is not itself a Trash entry, so the projection's `standingDeletes` also holds
  its root id while it stands for something it put back: an entry, or a member of a folder's
  cascade (a restore of one chapter out of a deleted folder), until a restore lifts that again.
  A Redo of a Redo's Undo, and so on round, works every time.
- **Undo writes where the change stands.** `undoChange` takes the view the caller acts in; when the
  record in force there is live (a drafted change an Apply landed), the opposite record goes to
  live. Its `draft` says which. No caller retries in another view.
- **`carries` says which record a record stands for.** An Apply's live copy and a restored
  Discard's pending copy each carry the root original's id, flattened (a copy of a copy names the
  same root). Undo of R takes back the last record in the view that is R or carries R, and writes
  `undoes` as that record's root, so the replay's setter stack, pending set and Trash entries
  (`from`) all match by the root. If none is in the view (still discarded, applied away,
  superseded), Undo answers `unknown`. Undo of an Apply and `restoreEntry` use the same match.
  `restores`, `restoredBy`, `appliedBy` and `fromDraft` say who and from where, not which record.
- **Whoever makes a record numbers a clash it can see** (`nameAmong`, Apply too); the replay
  numbers only the clashes nobody saw. A move that numbers its arrival carries the name itself,
  not a paired `rename`.
- **A repeated command is the caller's to answer.** The package throws when a command id was
  already used (`assertNewCommand`); the document command table answers a repeat first.
- **Apply never blocks.** `applyDraft(writer, draft, by, command, only?, saw?)` lands what the
  replay can place, widening a partial selection to the drafted prefix it stands on, and
  returns `{ command, copies, left, superseded, lifted }`: `left` is each record it did not
  land with `would_loop` or `purged`, `lifted` the copies that lifted a delete (rule 9).
  `covers(doc, saw)` says whether a copy holds the state the writer saw.
- **Undo of an Apply goes per fact**: `undoApply(writer, applied, by, command, { writtenSince,
  restoredByApply })` writes each landed copy's opposite record through `undoChange` (a create's
  opposite is a delete that keeps what others put inside standing), then puts the originals back
  to pending. It answers `{ undone, left }`; a fact something changed since is `left` with
  `changed_since`. `undoChange` answers `changed_since | purged | already | unknown`.
- **A Discard is final.** `restoreDiscard` appends fresh pending copies of what the command
  settled, on the branch the caller names (the Work's current one, which may differ from the one the
  Discard closed): new record ids, the same node ids, `carries` naming the
  original, `restores` the Discard and `restoredBy` who restored it (server only; `actor` stays who drafted it). They land after anything drafted since, so the restored change wins on a
  fact both touched; each pending record a copy overrides (same node, same fact: a rename's name
  and type, a move's place; a restore overrides a pending delete; a create or delete overrides
  nothing) is settled discarded under the restoring command, so restoring that command brings it
  back as a copy that wins in turn. Nothing is refused. A copy whose node cannot be acted
  on once the copies are in (purged, or its create is held by another Discard) is left out and
  returned (`leftOut`, `why: "purged"`). A Discard restores once (`discardedBy(...).restored`); `discardedBy` lists what a
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
- **The server's settlement actor is `system`.** A `dropped` is not any account's act.

## What the server must do

- Put the server's Yjs copy under one client id below 1,000, and call `admit` under the list's
  lock; it changes that copy in place, so reload the copy from the journal if anything throws
  (`CopyFault` included). Write the records and the `dropped` stamps to the journal and the rows.
- Fill `Connection` with the open drafts and the closed Works' sources: the package knows no Work.
- Move a document between two lists with `moveBetweenLists`, writing both updates in one
  transaction. In the list it left the node is in no view and in no Trash entry.
- Replay live and the views a record can change, then `changedRows` against the last rows.
- Give the writer `pendingText` for views it replays: this package cannot see text.
