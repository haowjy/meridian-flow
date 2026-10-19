# Document removal records

This recipe covers removal records, draft closure, creation admission and server room retirement.
Run it on a disposable stack. Use `./mf` for server setup/readback and finish
by deleting a document in the browser. The record lookup is owner-gated through
`POST /api/projects/:projectId/context/availability`.

## Populated upgrade (0069 to 0072)

1. Dump a populated 0069 database into a **new scratch database**, never another
   checkout's database. It needs a user, project, manuscript source and Work.
2. Run `tools/qa/probes/document-removal-upgrade.sql` with `psql -w -v
   ON_ERROR_STOP=1` against the scratch copy.
3. Run 0070 transactionally, 0071 **without a transaction**, then 0072
   transactionally. Re-run 0071.
4. Read the four `a1-` documents: tree and both cascade rows must be `deleted`;
   the hidden end-use row must be `discarded`. Cascade takes precedence over
   hidden. Read `a1-active`: closed, `document_removed`, revision 18 (was 17).
   Read `a1-closed`: closed, `discarded`, revision unchanged. The current
   generation's pending part must be exactly `{"kind":"discarded"}`; the older
   generation's part must remain pending. Its tree-use row must be absent.
5. Confirm another 0071 run changes none of those values, and remove the scratch
   database.

The migration fixture is retained because the upgrade transforms persisted
writer data. No additional unit case is needed for these recipe-covered risks.

## Current producers

- Create and delete a document with `./mf doc put` and `./mf doc rm`. Read
  `documents`: reason `deleted`, authenticated writer in
  `deleted_by_user_id`, no Work marker or system cause.
- Create a draft through a draft-mode chat, then use Discard all. The hidden
  created document must have reason `discarded` and that writer's ID, never
  `deleted_by_work_id`.
- Create Scratch in a named Work. Delete that Work: reason `deleted`, Work
  marker set. Availability must say `authority-unavailable`, not independent
  deletion. Restore the Work: all removal fields are null.
- Move a file over another with overwrite: the victim records `deleted` and
  the writer; the moved document remains living.
- Retract a create after a failed write and after reply rollback: reason
  `discarded`, system causes `create_failed` and `reply_rolled_back`.
  A prior completed tool response followed by Stop is **not** this scenario:
  the prior response has already saved.
- Seed an unused hidden document, then create at its path; separately invoke
  read-triggered hidden-node repair. Both old identities must record
  `discarded` with system cause `repair`.

Read removal records through `DocumentRemovals.lookup`: only tombstones
appear, actor names are current, unknown historical actors remain null.
Instantiate `DocumentRemovedError` with one result and check it retains the
same document ID and record. The optional availability `removal` is filled
only on identities its existing view exposes: hidden tombstones are currently
not visible, even to the branch view after its tree-use row is gone.

## Removal protocol

1. Open a document with a pending Work draft in both a live room and a draft
   room. Delete it through the tree. Observe the **client close code**, not
   only its reason: both must be `4208 document-deleted`. Hocuspocus's protocol
   close alone reports `1000` even with the right reason; the gateway transport
   must close first. Drafts remain closed with `closed_cause=document_removed`,
   current-generation pending parts become discarded, all tree-use rows disappear
   and every affected Work's stored pending count drops.
2. Pause at `removal.afterClose`, then abort the transaction. No room/runtime
   retirement or recount may run. The document and drafts remain living/active.
3. Race the first Work-draft ensure and first peer creation separately against
   removal. Pause creation at `draft.ensure.afterDocumentLock` or
   `draft.peer.afterDocumentLock` for creation-first. For removal-first pause
   at `removal.afterClose`. Removal either closes the inserted row or creation
   refuses with `DocumentRemovedError`. No active peer may remain.
4. Pull a peer whose ID sorts before its upstream while removing the document.
   The pull holds the upstream shared row lock before its peer update lock;
   removal must wait on parents before locking any peer, without a deadlock.
5. Move over a drafted victim, and move opposite-direction multi-document
   folders whose path order reverses their document-ID order. Victim drafts
   close and keep their removal record; both moves finish. Also race folder
   deletion with a save holding a living child's mutation lock: deletion must
   wait **before** `split.beforeRepoint`, because the split updates hidden
   boundary document rows too.
6. Delete a draftless binary creation and a revealed creation. The tree-use arm
   must take each Work's count from one to zero even without a draft journal.
7. Discard a hidden creation, then retract a reply's unused creation. Rows stay
   closed with cause `discarded`; journal rows and inline bytes are released.
   `state` and `state_vector` are zero-length bytea (not an empty Yjs document),
   `live_cut` and `discarded_state_vector` are NULL. Wait beyond room checkpoint
   debounce and check they remain released. Removal owns the sole `4208` room
   path for tombstones; generic Discard/retraction retirement applies only to
   documents that survive. A creation shared by two Works survives the first
   Work's Discard and keeps the other Work's active draft.
8. Time the document-lock hold separately from fixture setup with ten drafts
   and many pending parts. Assert no room close before commit and check every
   part actually settled; do not treat skipped work or a busy-host sample as a
   performance improvement.

`DocumentRemoval.remove` requires the caller's complete, sorted document-lock
set after Work/namespace admission and before document row locks. Keep a batch's
Works recount in its own root transaction after commit. Do not add Work locks
while holding the removed documents or drafts.

## Browser finish

Sign in, create/open a document, delete it using its Files menu, and confirm
the tab/tree update without an error. Capture a screenshot outside this repo.
The removal notice and terminal client presentation belong to E2's client
lane; the server close code is covered above.
