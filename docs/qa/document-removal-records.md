# Document removal records

This recipe covers removal records, which removals close drafts, creation
admission and server room retirement. The two removals differ:

- **A live delete** (a document's or folder's delete, a move's victim) changes
  live only (D79). It closes the document's live rooms `4208` and no draft:
  every active draft, its draft rooms and its pending parts stay, and the
  drafting Work's branch keeps the document.
- **A discarded creation** (Discard, reply retraction, repair) closes the
  creation's drafts with it, then tombstones it; its draft rooms close `4208`.
Run it on a disposable stack. Use `./mf` for server setup/readback and finish
by deleting a document in the browser. The record lookup is owner-gated through
`POST /api/projects/:projectId/context/availability`.

## Populated upgrade (0071 to 0074)

1. Dump a populated 0071 database into a **new scratch database**, never another
   checkout's database. It needs a user, project, manuscript source and Work.
2. Run `tools/qa/probes/document-removal-upgrade.sql` with `psql -w -v
   ON_ERROR_STOP=1` against the scratch copy.
3. Run 0072 transactionally, 0073 **without a transaction**, then 0074
   transactionally. Re-run 0073.
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
   Pause 0073's first parent-close UPDATE with a scratch-only trigger waiting on
   an advisory lock. While paused, commit production Work Restore
   (`restoreWorkDocuments`) from another connection, then create a new active
   draft of the restored document. Release the barrier. Every old parent (the
   last page's included) and the peer close with `document_removed`; only
   current-generation parts settle; the new draft stays active. 0073 closes a
   queue it fills once at its start, never re-reading tombstones, and drops it.
7. Seed a stale stored Work count, including one that should become zero.
   Check the exact pending-document rule after upgrade: stored counts agree
   and each changed Work's `entity_revision` advances once. Re-run 0073:
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
Check `livingDocumentRefusal` on a tombstone returns a `DocumentNotFoundError`
with the same document ID and its record in `removal`. The optional availability `removal` is filled
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
   only its reason: the live room must close `4208 document-deleted`.
   Hocuspocus's protocol close alone reports `1000` even with the right reason;
   the gateway transport must close first. The draft room stays open and its
   typing saves; the draft stays `active` with its pending parts, the Work's
   pending count is unchanged, and the Work's branch still lists the document
   at its path (`./mf` read in that Work), while live and other Works see it
   gone. Discard all then closes the draft as usual.
2. Pause at `removal.afterRecord`, then abort the transaction. No room/runtime
   retirement or recount may run. The document remains living.
3. Hold both a living document's mutation lock and its Work row lock on one
   connection; ensure its already-active draft on another. It returns
   immediately with no locking SQL. Then race the first Work-draft ensure and first peer creation separately against
   removal. Pause creation at `draft.ensure.afterDocumentLock` or
   `draft.peer.afterDocumentLock` for creation-first. For removal-first pause
   at `removal.afterRecord`. A first Work draft created first stays active
   through the delete; removal-first, its creation refuses with
   `DocumentNotFoundError` carrying `removal`. A peer of an existing Work draft
   is created either way (the Work draft outlived the delete).
4. Pull a peer whose ID sorts before its upstream while deleting the document
   live: the delete locks no draft row, so the pull finishes without waiting on
   it and the peer stays `active`. Then pull while Discarding a hidden creation
   with a peer: the pull holds the upstream shared row lock before its peer
   update lock, and the discard's close locks upstream Work drafts before peers,
   so it waits on the parent before any peer, without a deadlock.
5. Move over a drafted victim, and move opposite-direction multi-document
   folders whose path order reverses their document-ID order. Victim drafts
   stay active (the branch keeps the review item without a name clash); both moves finish. Also race folder
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
   reads "<name> deleted <title> before this reply saved its change." (passive
   without a name), never "You discarded this new document".
10. A Work Restore that commits before a Work delete's retirement runs keeps
   the restored live room. Restart with `HOOK_PAUSE_AT=draft.beforeRetirement
   HOOK_PAUSE_FILE=<file>`, touch the file, delete a Work whose scratch holds an
   open document, restore the Work, reopen the document in a tab, then delete
   the file. The tab stays connected (no `4208`) and typing saves.
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

## Document trash

1. Create one document at a scheme root and one inside a folder. Delete the
   document, then delete the folder. The sidebar adds Trash above Scratch.
2. Open Trash. Both documents appear newest first with their former area and
   folder, deletion actor and date, days left, and Restore. Reload while the
   list is open; the same list remains.
3. Restore one document. Its row says Restoring until the response, leaves the
   list after success, and the catalog stream returns it to the context tree.
4. Create a document at the other deleted document's former path, then restore
   the deleted document. Confirm the row leaves Trash and the success message
   names the alternate location where it landed.
5. Empty Trash by restoring the remaining rows. Close the list and confirm the
   sidebar row is gone. Repeat through the phone navigation drawer; Trash opens
   the same auxiliary list and closes the drawer.

## Removal notices in the browser

Two tabs of one signed-in browser (A and B), plus `./mf doc rm` as another
device. Every removal by a person names the actor from the record: "<name> deleted
<title>." ("<title> was deleted." without a display name), never "you" or "elsewhere".
After the removal commits, a live delete closes the document's **live** rooms
`4208` and leaves its draft rooms open; a discarded creation's draft rooms close
`4208`.

Each case names the destination A's tab is hosted on. A **live tab** shows the
manuscript document itself; a **draft tab** shows it through A's Work draft
(the Work has a draft of it, with pending changes or none). Unless a case says
otherwise, A's tabs are live tabs.

- A has a draft tab of a document (once with pending changes, once with none
  left after a per-change Discard); B deletes it from Files. The tab stays,
  its draft room stays connected (no `4208`) and typing saves; it shows the
  deleted state instead of a removal chip. A live tab of the same document in
  another Work closes as below.
- A shows a document with a long one beside it; B deletes it from Files. A
  falls back to the long document and the tab strip's free end shows a dashed
  chip "<name> deleted <title>." ("<title> was deleted." without a name); nothing covers the text. B says
  nothing. Selecting another tab clears the chip; so does Dismiss.
- A's only tab is deleted (`./mf doc rm`): the landing's top margin says the
  sentence; the Recently opened list does not move.
- B deletes a folder holding three of A's open tabs: one chip, "<name> deleted 3
  documents (one, two, and three).", the names in its tooltip.
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
- B Discards a created document A is reviewing: A says "<name> discarded <title>
  from the draft." Reopen its review address: the pane says the
  same in place of "This destination is unavailable".
- Apply during a removal: restart with `HOOK_PAUSE_AT=apply.beforeBoundary
  HOOK_PAUSE_FILE=<file>`, touch the file, click Apply on a living document's
  item, `./mf doc rm` the document, delete the file. The click did not know of
  the delete, so it answers `needs_restore`: nothing changes, the document
  stays deleted and the draft pending, and the review asks before restoring.
  Confirm: the new click carries `restore` and answers `applied` with
  `restored: true`, and the document is back in the manuscript with the change.
  Apply all over a deleted document confirms first, naming it; a document
  deleted after that confirmation answers `needs_restore` the same way.
- The app's surfaces for a Work with pending changes to a deleted document
  (seed with `./mf`: a draft-mode chat's reply edits the document, then delete
  it from the tree). The delete dialog says "<title> will be deleted." and
  names the Work: "The Work <name> has changes to it. Applying them brings it
  back." (never a handle like `w3`). After the delete the chat dock row and the
  Work page's Changes to review row keep the file with "Deleted from the
  manuscript" on its status line; an open draft tab stays open. A dock with
  several files, or Work Files' "Apply all changes", asks first: "Applying
  brings back <title>, which was deleted from the manuscript." with Cancel and
  Apply, in the footer below the rows (as Discard all's question does): no row
  moves when it opens. Applying leaves "<title> is back in the manuscript." in the surface's
  notice slot and the tree shows the document again. To force `needs_restore`,
  route the Work's `**/works/<W>/branches` list to its pre-delete body before
  the delete, then Apply all: the list asks again by name and the row says
  "This document was deleted from the manuscript. Apply again to bring it
  back." Create a new document at the deleted one's path: Apply remains offered
  in Work Files, the chat dock and the editor. Apply restores the draft at the
  next free name, and the surface says where it landed.
- The draft editor's manuscript state never moves the page. With a draft tab
  open, `./mf doc rm` its document from another device: "Deleted from the
  manuscript" appears in the identity row's free end (desktop) or the review
  row (phone), and the heading's top is unchanged before and after
  (`getBoundingClientRect().top`). A narrow slot shows the short label; the
  button opens the full sentence. After Apply draft, reselecting the tab shows
  "<title> is back in the manuscript." in the same place, with Dismiss.
- B runs Work Files' Discard all while A holds a draft tab of a deleted document
  or of a created document only the draft has: A's tab closes (the draft's
  metadata answers `gone` once retired, without a content grant) and A's
  Editor stays usable. Before the fix the created document's tab looped
  ("Maximum update depth exceeded" in `EditorReviewIntentClaimant`) and the
  project failed to load.
  A draft left with no changes (apply its only change from the editor, so the
  list is empty) whose document is then deleted from another device keeps its
  tab on the draft, across a reload too, and typing in it lists the document
  again as deleted: the review address resolves through the draft
  (`admitDrafts`), while a path still finds the document gone.
- A stale 4208 (an init script dispatching the close on the page's `/ws/yjs`
  socket while the document exists): the room reconnects within a few hundred
  ms and typing saves. A second stale 4208 on the same tab reconnects too.
- A stale 4208 while `POST /api/projects/:projectId/context/availability`
  fails: the tab says "Access lost (not saving to the server)"; once lookups
  succeed (focus, online or the 60 s poll) the room reconnects and typing
  saves.
- Discard every change of an existing document's draft while it is open in a
  live tab or the dock, then `./mf doc rm` it: the removal's chip shows (the
  Discard left no mark). The same with a draft tab: the draft is still active
  with no changes, so the tab stays writable as in the draft-tab case above.
- B Discards a created document A reviews in the dock beside Chat: A's dock
  says "<name> discarded <title> from the draft." beside "Recent".
- A folder delete closing several tabs reads "<name> deleted 3 documents
  (one, two, and three)." (names in the locale's list form).
- A holds unsent text in a live tab (block its `/ws/yjs` sockets, type), B
  deletes: A closes with the notice and the unsent text is lost (a recorded
  divergence). In a draft tab the room stays, so the text saves once the
  sockets unblock.
