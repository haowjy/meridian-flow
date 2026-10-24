# Nothing writes a removed document into being

Runtime checks for W52's write side: live admission refuses a removed document
under its mutation lock, only a create or explicit repair makes a Yjs head, and
Apply brings a deleted document back only when the writer knew it was deleted
(`restore`, D79). Run on an owned mock stack
(`MODEL_PROVIDER=mock pnpm dev`). A tab is `@hocuspocus/provider` over `ws` on
`/ws/yjs` with the `./mf` dev cookie and the `meridian.collab.<version>`
subprotocol; durable state is read with `psql` on this checkout's database.

Pauses use the dev-only hook controller: start the stack with
`HOOK_PAUSE_AT=<point>` and `HOOK_PAUSE_FILE=<file>`, create the file, and
the operation that reaches the point waits, with its locks, until the file is
deleted (`shared/test-hook-controller.ts`; points in `shared/test-hooks.ts`).

1. **Removal against a live frame.** Sync a tab on a document. In a SQL
   session, take `pg_advisory_xact_lock(hashtextextended('document-mutation:' ||
   <id>, 0))`, tombstone the row with its record, and hold. Type in the tab: the
   frame waits on the lock (`pg_stat_activity`). Commit. PASS: the tab closes
   `4208 document-deleted`; no new `document_yjs_updates` row. Control without
   the tombstone: one row, no close.
2. **A save holds the lock through confirmation.** Pause at
   `save.afterDocumentLock`, send a No Work chat a scripted insert, and once the
   lock is held ask for it from a SQL removal. PASS: the removal waits; after
   the file is deleted the reply's row commits first and the removal's lock is
   granted after it.
3. **Reply write staged before a delete.** Pause at `save.afterWorkLock`; a
   draft-mode chat inserts; `./mf doc rm` the document; resume. PASS: no draft
   or live row for the write; an open live tab holds no AI text; the receipt
   says the file was deleted before the reply was saved. Repeat in a No Work chat.
4. **Staged create after Discard.** Pause at `save.beforeWorkLock`; a
   draft-mode chat creates a file; Discard all the Work's branch; resume. PASS:
   the hidden row is a `discarded` tombstone with no head, no checkpoint, no
   other row at its name. Then compaction, the generation reader, provenance and
   seed on that id refuse with `DocumentNotFoundError` carrying `removal`, and no head appears.
5. **Repair.** `./mf doc put` a document, delete its updates, checkpoints and
   head in SQL, then open a tab cold. PASS: the room shows the projection's text;
   the head has one `seed` checkpoint; typing journals.
6. **Apply against a removal.** A draft-mode chat edits document A. Start the
   stack with `HOOK_PAUSE_AT=apply.beforeBoundary`, click Apply on A (its row
   doesn't show a delete yet), `./mf doc rm` A while the click waits, resume.
   PASS: the answer is `needs_restore`; A's `deleted_at` is unchanged, its
   draft is still `active`, and it has no AI live row. Apply again from the row,
   which now says "Deleted from the manuscript": the click carries `restore`,
   the answer is `applied` with `restored: true`, A is living with the draft's
   text. The same race runs unattended as rows of
   `pnpm exec tsx tools/qa/probes/atomic-apply/run.mts`.
7. **A taken path.** Delete A live, then create a document at A's path. PASS:
   Apply with `restore` is `applied`; A is restored at the next free name and
   the result carries a `renamed` note with the requested and landed paths.
8. **The receipt names who removed it.** Start the stack with
   `HOOK_PAUSE_AT=save.beforeWorkLock` (the save must not hold the Work lock the
   delete needs). A draft-mode chat replaces a line; pause, `./mf doc rm` the document,
   resume. PASS: the write's result reads "This file was deleted by <name> before this
   reply was saved, so this change wasn't made." (a name appears only when the user row
   has one: dev login blanks it, so set `users.name` after the delete and before
   resuming), and the chat's card reads "<name> deleted <title> before this reply saved
   its change." (or "<title> was deleted before this reply saved its change." without a name; the result carries `rejected: "removed"` and the record in `removal`).
   Repeat in a No Work chat.
