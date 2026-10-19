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
5. Give a removed shared creation more than 500 branch-use rows. Capture
   statement-level DELETE transition-table counts: no page deletes more than
   500 uses. Hidden cascade-marked uses remain; revealed and independent tombstones lose theirs.
6. Pause 0071's parent-close UPDATE with a scratch-only trigger waiting on an
   advisory lock. While paused, commit production Work Restore from another
   connection. Release the barrier. The parent and its earlier-sorting peer
   must both close with `document_removed`; only current-generation parts
   settle. Restore must not make later passes skip that closure.
7. Seed a stale stored Work count, including one that should become zero.
   Check the exact pending-document rule after upgrade: stored counts agree
   and each changed Work's `entity_revision` advances once. Re-run 0071:
   no revision, closure, placement or count changes.
8. Legacy schemas permit a hidden creation in a Work-owned source although
   production routes Scratch/uploads live and rejects their draft creation.
   Seed one with retained Yjs prose and a tree use. Cascade, then Restore and
   hidden-node repair. Membership is inactive while removed; after Restore
   it is present again, the draft stays closed, and repair erases nothing.
   Remove the scratch database.

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
on every tombstone availability answers `deleted`: visible tombstones, and a
discarded creation that still places (a hidden one in a discarded draft folder,
any other hidden tombstone, and a living hidden document stay not visible).
A malformed living hidden identity in its branch still emits
`ProjectContextIdentityInconsistent`; only a discarded removal record can
suppress that classification. All-living availability requests issue no
removal-record query; mixed requests query only the deleted IDs. Direct,
list, and draft file facts for a discarded creation are deleted facts, so
known-id denial can include its record without allowing content access.

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
3. Hold both a living document's mutation lock and its Work row lock on one
   connection; ensure its already-active draft on another. It returns
   immediately with no locking SQL. Then race the first Work-draft ensure and first peer creation separately against
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

## Removal notices in the browser

Two tabs of one signed-in browser (A and B). The dev user has no display name
(dev login re-provisions it on every request), so a named actor needs a
throwaway name on this worktree's database; drop it afterwards. The server closes the
removed document's live and draft rooms with `4208` after the removal commits.

- A shows a document; B deletes it from Files. A's tab closes and the pane's
  foot says "<title> was deleted by <name>." B says nothing. One `/ws/yjs`
  close in A, no new opens after.
- Same with another tab open in A: A lands on that tab with the same notice.
- Socket first: `./mf doc rm` the document A shows (no browser tab of B
  refreshes A's catalog first). The 4208 closes A's tab with the notice; no reconnect.
- A reviews a document's Work draft; B deletes the document. Same notice;
  both rooms close once. Reopen it from the Work's Files: the pane says the
  sentence in place of "This destination is unavailable".
- A deletes from its own Files menu, or Discards a created document from its
  dock: nothing is said.
- A reviews a created document; B Discards it from its dock: A says
  "<title> was discarded from the draft." Reopen its review address: same.
- A holds unsent text (block its `/ws/yjs` sockets, type), B deletes: A closes
  with the notice and the unsent text is lost (not yet kept).
