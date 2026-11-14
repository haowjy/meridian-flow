# Collab — draft model and durable records

A branch ID, draft ID, item key and presented address are different identities. An
**item** is one document's reviewable change, keyed `${branchId}:${documentId}`; a
document with no draft can still be an item and can still be applied. A **presented
address** is the writer's Work/item/change selection and names no draft storage ID.
The server resolves every item key through the identity module; no caller accepts an
ambiguous bare ID. There is at most one active Work draft per
`(documentId, branchId)`.

`DraftReplayJournalReads` uses the ambient transaction, so it sees the command's
uncommitted receipts.

## Draft store

Writes go through two doors. `appendRows` adds rows past the checkpoint, sequenced by
the draft row's lock rather than fenced by a revision (see the append contract in
[CONTEXT.md](CONTEXT.md#transaction-and-lock-contracts)). `commitRewrite` writes a new
checkpoint covering every row of the draft, under an `exact` policy (the revision it
was computed at) or a `fold` policy (any appends since its cursor are applied). Model
turn inverses are exact rewrites; compaction is a fold rewrite. Live-to-Work content
rebases are server appends, not Yjs pulls.

These writes stand outside the doors: the shared close (`drizzle-draft-close.ts`), the
projection job's effect write, creation and its seeds, which insert the row
(`ensureDocumentDraft`), and retraction and tree deletion,
which delete it.

A Work draft's insert also stores the live room, the live and draft seed snapshots,
the paired live journal position and state, and the live-origin map for copied
top-level blocks. Those cuts project a first draft write's live observation into
revision 0 and attribute any gap between that observation and the seed; they don't
gate the write. A row without the state-and-position pair reports the seed as
unattributed. The map never changes, and a race loser reads the winner's record.

Typing, rebase and Apply don't encode an unused after-cut under the hold. The
replica's cached encoding supplies a no-tail append's before-cut, and the finalized
immutable doc's lazy encoding is shared by the save cut and the installed replica.

A document rebuilt from journal rows is integrable only after every row has applied
with no pending structs and no pending delete set. State-vector equality, or a
pending-struct check before applying, is not enough.

A room release queues a live checkpoint's immutable binding, and a worker captures a
durable cut after the releasing transaction commits. A dropped or late checkpoint
costs replay time, never data.
