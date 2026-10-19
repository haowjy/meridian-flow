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
6. Give the removed cascade creation 501 active Work drafts on distinct branches
   (so they span two closure pages) and an earlier-sorting peer of the first.
   Pause 0071's first parent-close UPDATE with a scratch-only trigger waiting on
   an advisory lock. While paused, commit production Work Restore
   (`restoreWorkDocuments`) from another connection, then create a new active
   draft of the restored document. Release the barrier. Every old parent (the
   last page's included) and the peer close with `document_removed`; only
   current-generation parts settle; the new draft stays active. 0071 closes a
   queue it fills once at its start, never re-reading tombstones, and drops it.
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

Read removal records through `readRemovalRecords` (`tree/removal.ts`): only tombstones
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
   debounce and check they remain released. The transaction's one retirement
   closes a tombstoned creation's rooms `4208` (another tab reviewing it sees
   the removal) and a surviving document's draft rooms stale. A creation shared
   by two Works survives the first Work's Discard and keeps the other Work's
   active draft.
9. A draft-mode reply stages a write into an existing document; the document is
   tree-deleted between the staging and its step's save (stack with
   `HOOK_PAUSE_AT=draft.ensure.afterDocumentLock`: the step's second tool call
   creates a document and parks there; `./mf doc rm` the first). The staged
   write's tool result reads "This file was deleted by <name> before this reply
   was saved, so this change wasn't made." with no retry, and its chat card
   reads "You deleted <title> before this reply saved its change.", never
   "You discarded this new document".
8. Time the document-lock hold separately from fixture setup with ten drafts
   and many pending parts. Assert no room close before commit and check every
   part actually settled; do not treat skipped work or a busy-host sample as a
   performance improvement.

`DocumentRemoval.remove` requires the caller's complete, sorted document-lock
set after Work/namespace admission and before document row locks. Works the
caller does not hold recount in their own root transaction after commit
(`recountAfterCommit`). Do not add Work locks while holding the removed
documents or drafts.

## Browser finish

Sign in, create/open a document, delete it using its Files menu, and confirm
the tab/tree update without an error. Capture a screenshot outside this repo.

## Removal notices in the browser

Two tabs of one signed-in browser (A and B), plus `./mf doc rm` as another
device. Projects are single-owner, so every removal by a person reads "You
deleted <title> elsewhere."; there is no named form. The server closes a
removed document's live and draft rooms with `4208` after the removal commits.

- A shows a document with a long one beside it; B deletes it from Files. A
  falls back to the long document and the tab strip's free end shows a dashed
  chip "You deleted <title> elsewhere."; nothing covers the text. B says
  nothing. Selecting another tab clears the chip; so does Dismiss.
- A's only tab is deleted (`./mf doc rm`): the landing's top margin says the
  sentence; the Recently opened list does not move.
- B deletes a folder holding three of A's open tabs: one chip, "You deleted 3
  documents elsewhere.", the names in its tooltip.
- Hold B's delete (route `**/context/*/delete*` to abort in both tabs, delete,
  wait 15 s, unroute, toggle B offline and online): A's tab closes at once with
  no chip, and the chip appears once the delete commits and A is focused, as
  long as A did not navigate meanwhile.
- A sits on Chat while B deletes one of A's Editor tabs: nothing shows on
  Chat; going to the Editor shows the chip once, and the next Editor
  navigation clears it.
- A opens a document beside Chat (the dock); B deletes it: the dock returns to
  "Recent" and its header's free end says the sentence in a chip.
- Narrow the window to 900 px with the dock open: the chip keeps a short
  sentence ("1 document deleted"), the full one in its tooltip; the tabs
  scroll instead.
- Phone shell (a coarse pointer; `agent-browser` needs an init script that
  answers `(pointer: coarse)`): the top bar's notice row says the sentence;
  browsing a folder clears it.
- A deletes from its own Files menu (a document in a tab, or in the dock), or
  Discards a created document from its review: nothing is said.
- B Discards a created document A is reviewing: A says "You discarded <title>
  from the draft elsewhere." Reopen its review address: the pane says the
  same in place of "This destination is unavailable".
- Apply during a removal: restart with `HOOK_PAUSE_AT=applyItems.afterStaging
  HOOK_PAUSE_FILE=<file>`, touch the file, click Apply, `./mf doc rm` the
  document, delete the file. The command answers `held` with `deleted_live` and
  the record; the review closes with the removal's chip.
- A stale 4208 (an init script dispatching the close on the page's `/ws/yjs`
  socket while the document exists): the room reconnects within a few hundred
  ms and typing saves.
- A holds unsent text (block its `/ws/yjs` sockets, type), B deletes: A closes
  with the notice and the unsent text is lost (a recorded divergence).
