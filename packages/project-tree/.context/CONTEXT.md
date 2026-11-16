# project-tree

The records, the replay, Apply, Discard, Undo and the guard on what a client sends of the project tree. The
design is `work/project-tree-design/design.md` in the docs repository (sections 2 to 6); this
page says where each part lives and what the code decided where the design left a choice.

## Modules

| File | Holds |
|---|---|
| `record.ts` | Record and settlement types, `source:<id>` roots, the two arrays (`ops`, `settle`) |
| `validate.ts` | `readStored` (every read of the list) builds the record a value stands for from its own allowed fields, or says why there is none; `writable`, which every record the package writes goes through; which fields are the server's |
| `names.ts` | `shownName` (the replay's name for a node of a kind: `normalEntryName`) |
| `list-index.ts` | `listIndex`: record ids, node ids and command ids kept with a copy; `assertNewCommand` |
| `view.ts` | `View` (live, or live then one Work), settlements, `viewValues` and `viewRecords`, `replayView` |
| `replay.ts` | `replay`: rules 1 to 13, then one pass over the nodes for Trash, kept folders and names |
| `shape.ts` | `childrenOf`, `descendantsOf`, `rankAt`, `fingerprint`, `treeViolations` |
| `writer.ts` | `TreeWriter`: makes records in one copy of the list |
| `apply.ts`, `undo.ts` | Apply, Discard, restoring a Discard, Undo of an Apply; Undo of one change |
| `admission.ts` | `guard` (the faults that close a copy), `clientMayWrite`, `admit`: guard, integrate, stamp `dropped` |
| `rows.ts` | `projectedRows`, `branchRows`, `changedRows`: what to write to SQL after a replay, with each node's type and extension |

## The rules

Each is in `replay.ts` and has a named case in `casebook.test.ts`.

1. A move that would put a folder inside itself is skipped (`skipped`, reason `cycle`).
2. A delete takes the node and the nodes its author saw inside it that are still inside it.
3. A node nobody deleted keeps the folders above it standing (`keptByChild`).
4. Two shown siblings with one name both stay, and both keep the name.
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
13. A name is `normalEntryName(kind, typed)` for the node's kind, in every create and rename;
    nothing is refused for its name.
14. Of shown siblings with one name, every one but the first to arrive (`arrivedAt`, then
    creation: list order, no clock) carries a `suffix`: the shortest start, four hex digits or
    more, of its id's hex digits (the uuid without dashes) that no other shown sibling's begins
    with. Its path segment is `name~suffix` (`segmentOf`). A segment with a suffix reaches the
    shown child whose id begins with it, the lowest id if two do, whatever name is in front; one
    without reaches the child of that name with no suffix (`childAtSegment`). Arrival is the
    latest of where it came to stand (a create or a plain restore), where its parent last changed
    and where the name it shows last changed (`stoodAt`, `placedAt`, `namedAt`), or a purge's
    rehoming. An Undo of a move or rename settles those from the changes still in force, and a
    restore that `undoes` a delete leaves them alone, so an Undo leaves the twins as they were.

A row that differs from live only in a suffix is no change the Work made: `BranchRow.changed`
is false, and the count and the Changes list skip it (`changedFolders`, the server's
`treeChanges`).

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
  (a node that is not there, a folder inside itself, a name already taken) is skipped, or stands
  as a twin, by the rules, the same in every replay; the writer keeps it in the list. The server writes one
  verdict, `dropped` (admission, below).
- **`guard` closes a copy that does what an honest client never does**: a deletion, content
  outside `ops`, a struct whose position cannot be decided (a gap in a writer's own clock, a
  pending struct), a client id below 1,000, a record kind or field only the server writes
  (`clientMayWrite`: `purge`, a file create, `carries`, `blob`), more than
  `MAX_RECORDS` records. It throws `CopyFault`; nothing is stored, and the room closes the
  connection with the one terminal code. Names, sources, drafts and types are not its business.
- **`admit` stamps `dropped`** on a record in a closed draft, on a record of a dropped node or
  a create inside a dropped folder, and on a record whose addition changes a closed source. The
  server decides: its arrival order is the one shared by all clients. Admission compares the held
  tree with the tree after the whole update and checks the added records' reported sources. If
  that gate fails, it doubles prefixes and bisects to find the next record to judge, leaving each
  dropped record out of later projections. A reported source can be a no-op, so the candidate is
  checked against its own full projection before it is dropped. The diff counts both sources of a
  move and changes to name, place, kind and shown state. In an in-process 300-record update against
  25,000 held records, no drop took 1.53 s and two replays; one closed-draft drop took 12.29 s
  and 24 replays. These single runs shared the machine with other workloads. Fallback replay cost
  grows with the number and positions of rejected or conservatively flagged records, with roughly
  logarithmically many gate checks per candidate, each replaying the touched views twice.
  A source with no database row is closed. The
  server's own records are never admitted. `viewValues` leaves dropped records out;
  `droppedRecords` reads their reason from the settle log for the browser.
- **Parts of one client's offline history** arrive in causal order and are admitted in order
  (the room queues a connection's messages); an honest client's parts are never a fault.
- **An Undo settles only its own node.** Replay skips an Undo whose target is a change on another node. Each taken change reports `sources`: the node's sources before and after that record, for Apply and Un-Apply, which append records.
- **A record is in force unless a later record in force undoes it** (`standingOf`;
  `projection.inForce`). An Undo names the root (`carries ?? id`) of the record it takes back in
  `undoes`, and takes out every record of that root. So a change with any Undo in force is out,
  and an Undo of an Undo brings it back only while no other Undo of it is in force. Every kind of
  record follows this one rule. The replay applies it as each Undo arrives, over that change's
  chain (the records whose `Change.base` has one root: the change, its copies, the Undos about
  them), and an Undo the replay skips is in no chain.
- **A node's name and place are what the moves and renames in force say.** The replay keeps, per
  node, the moves and renames in force on its name (with type) and on its place, in list order
  (`history`), and the node shows what the last of each says, or what its create said; a
  server read of "who renamed or moved this" takes the last of each list. An Undo of a move or
  rename sets nothing itself: at its place in the list it puts the changes it flips out of the
  node's lists or back in at their own places (`withTurned`), and the node shows what they then
  say. The name, parent and rank it carries are what its author's copy showed, and nothing reads
  them to decide. So two copies out of step settle on one tree: a stale Undo leaves a rename or
  move its author never saw, and a second Undo of one change changes nothing. An Undo that would
  leave the node under a folder that is gone or inside it is skipped whole (rule 1), and nothing
  it is about changes. A turn changes only that node's lists: what the node did earlier in the
  list is not replayed again, so another node's move is never skipped because of it. Rule 4's
  arrival is where the node's parent or shown name last changed by a change in force: an Undo
  gives back the arrival it had, and a change back in force arrives at its own place.
- **Readers of an Undo ask what it turned, not its type.** `projection.changes` has every record
  the replay took by its id; `Change.base` is the change at the bottom of its chain of `undoes`,
  whose `sets` say which facts it sets. Apply's `factsIn` gives an Undo its
  base change's facts; the review row reads the Work's tree against live after one.
- **`undoChange` on a move or rename, or on an Undo about one**, works out what taking it out does
  to the change it is about (`base`): out of force, back in, or neither, when another Undo of it
  is in force. Then it puts those changes out or back on the node's `history` (`withTurned`, as
  the replay does) to see what the node would show. It answers `already` for a record not in force,
  `changed_since` when a later change in force holds every fact that would turn, or the place it
  would go back to is inside the node now, and writes nothing then. When nothing would turn because
  another Undo keeps the change out, it writes the record all the same: Un-Apply of an applied
  stale Undo has to take that copy out, so a later Undo of the other Undo doesn't find the change
  still taken out by the Apply. The record is a move when the place turns, a rename when only the
  name does (the replay's Trash reads that: a rename leaves the deletes a move lifted lifted), and
  otherwise of the base change's type.
- **Creates, deletes and restores** follow the same in-force rule, but Trash keeps its own
  record-order account: it counts each delete of a node, and a restore lifts deletes outside any
  Undo chain (a plain restore, rule 9). `undoChange` on them takes back the last record in force
  of the chain that undid and redid them (`redoneAs`). Undo of a delete is allowed while that
  delete is a Trash entry in force. The opposite record of a
  restore puts back the deletes that restore lifted, under their own ids, with what each took (the
  replay keeps what each restore lifted): the entry is the original delete again, so its Undo and
  `restoreEntry` reach it, and a restore that takes that Undo back lifts them again. That
  opposite delete is not itself a Trash entry, so the projection's `standingDeletes` also holds
  its root id while it stands for something it put back: an entry, or a member of a folder's
  cascade (a restore of one chapter out of a deleted folder), until a restore lifts that again.
  Making Trash follow the in-force rule is a design of its own.
- **Undo writes where the change stands.** `undoChange` takes the view the caller acts in; when the
  record in force there is live (a drafted change an Apply landed), the opposite record goes to
  live. Its `draft` says which. No caller retries in another view.
- **`carries` says which record a record stands for.** An Apply's live copy and a restored
  Discard's pending copy each carry the root original's id, flattened (a copy of a copy names the
  same root). Undo of R takes back the last record in the view that is R or carries R, and writes
  `undoes` as that record's root, so the replay's changes in force, pending set and Trash entries
  (`from`) all match by the root. If none is in the view (still discarded, applied away,
  superseded), Undo answers `unknown`. Undo of an Apply and `restoreEntry` use the same match.
  `restores`, `restoredBy`, `appliedBy` and `fromDraft` say who and from where, not which record.
- **`projection.inForce` is the one reading of which records are in force**, worked out by
  the replay. `undoChange` answers `already` for a record that is not,
  and `appliedNodes(doc, command, restoredByApply)` is the one reader of what of an Apply still
  stands: the nodes whose live copies are in force, and the nodes whose Apply-made `restore` (the
  ids `undoApply` takes back) is in force. An Apply that only brought a document back from Trash
  lists it until Un-Apply or a card's Undo takes the restore back. A tab can tell the Apply's tree
  half has ended (a card's Undo of the drafted change took the copy back). `appliedBy` keeps
  copies not in force, so `undoApply` reports them `already`. One Undo takes out every copy of a
  record: when a record applied, Un-Applied and applied again has its first copy back in force (an
  Undo of the Un-Apply's Undo), Un-Apply of the second Apply takes out both. After a copy of
  an Undo, Apply reads what live has from a replay, not the copy's fields.
- **Nothing numbers a name.** A writer stores the typed name (`shownName`) whatever its siblings
  are called, and a clash stands as twins (rule 14). Apply copies the drafted name as it is: the
  twin the Work shows suffixed arrives last in live too. A move sets only the place and carries no
  name; an old stored move's `name` is dropped when it is read.
- **A repeated command is the caller's to answer.** The package throws when a command id was
  already used (`assertNewCommand`); the document command table answers a repeat first.
- **Apply never blocks.** `applyDraft(writer, draft, by, command, only?, saw?)` lands what the
  replay can place. A partial selection takes only what it stands on (`prerequisites`): the
  drafted creates of the nodes it needs and of the Work-created folders above where each record
  acts, each such folder's last drafted delete or restore before the record, and earlier records
  on the same fact; every other pending change stays pending. When landing that would change what
  the Work's tree showed, it widens to the drafted prefix it stands on, and
  returns `{ command, copies, left, superseded, lifted }`: `left` is each record it did not
  land with `would_loop` or `purged`, `lifted` the copies that lifted a delete (rule 9).
  `covers(doc, saw)` says whether a copy holds the state the writer saw.
- **Undo of an Apply goes per fact**: `undoApply(writer, applied, by, command, { writtenSince,
  restoredByApply })` writes each landed copy's opposite record through `undoChange` (a create's
  opposite is a delete that keeps what others put inside standing), then puts back to pending the
  records this Apply settled whose copies went back, matched by root (`carries ?? id`): a restored
  Discard's record is itself a copy, so its id is not its live copy's `carries`. It answers
  `{ undone, left }`; every copy not taken back is in `left` with its why (`changed_since`,
  `purged`, `already`, `has_text`). `undoChange` answers
  `changed_since | purged | already | unknown`.
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
  restore copies, kept creates) is built through `writable`,
  which runs `readStored` on it and throws, saying why, when the reader would drop it. A name
  with a `/` or over 255 characters is thrown at the caller, not stored and then lost from every
  view.
- **A document's `create` states its `filetype`**, from a client and from the server; a file's
  type is in its blob. The replay never has to guess a document's type.
- **The server's settlement actor is `system`.** A `dropped` is not any account's act.

## What the server must do

- Put the server's Yjs copy under one client id below 1,000, and call `admit` under the list's
  lock; it changes that copy in place, so reload the copy from the journal if anything throws
  (`CopyFault` included). Write the records and the `dropped` stamps to the journal and the rows.
- Fill `Connection` with the open drafts and the closed Works' sources: the package knows no Work.
- Nothing moves between two lists (a project's and the account's): a list is the unit of
  history, so between two the server copies, and the copy is new nodes in the list it lands in.
  A `move` whose parent is no node of the list (an old `list:<id>` leave record in a dev
  database) is skipped as `missing-parent`, so the node stands where it was before it.
- Replay live and the views a record can change, then `changedRows` against the last rows.
- Give the writer `pendingText` for views it replays: this package cannot see text.
