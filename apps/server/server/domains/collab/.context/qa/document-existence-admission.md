# Nothing writes a removed document into being

Runtime checks for W52's write side: live admission refuses a removed document
under its mutation lock, and only a create or explicit repair makes a Yjs head. Run on an owned mock stack
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
2. **A model edit holds the lock through its commit.** Pause at
   `command.afterLock`, send a No Work chat a scripted insert, and once the
   lock is held ask for it from a SQL removal. PASS: the removal waits; after
   the file is deleted the reply's row commits first and the removal's lock is
   granted after it.
3. **A model edit held before its claim, then a delete.** Pause at
   `command.beforeClaim`; a draft-mode chat inserts; `./mf doc rm` the document;
   resume. The edit has taken no lock, so the removal wins. PASS: no live row for the
   write; an open live tab holds no AI text; the receipt says the file was
   deleted before the edit ran. Repeat in a No Work chat.
4. **A held create, then Discard.** Pause at `command.beforeClaim`; a
   draft-mode chat creates a file; Discard all the Work's draft; resume. PASS:
   the hidden row is a `discarded` tombstone with no head, no checkpoint, no
   other row at its name. Then compaction, the head reader, provenance and
   seed on that id refuse with `DocumentNotFoundError` carrying `removal`, and no head appears.
5. **Repair.** `./mf doc put` a document, delete its updates, checkpoints and
   head in SQL, then open a tab cold. PASS: the room shows the projection's text;
   the head has one `seed` checkpoint; typing journals.
6. **The receipt names who removed it.** Start the stack with
   `HOOK_PAUSE_AT=command.beforeClaim` (the edit must not hold the Work lock the
   delete needs). A draft-mode chat replaces a line; pause, `./mf doc rm` the document,
   resume. PASS: the write's result reads "Not in the document: this file was deleted by <name> and is in the trash, so this edit was not kept anywhere." (a name appears only when the user row
   has one: the dev auth bypass user has none, so set `users.name` after the delete and before
   resuming), and the chat's card reads "<name> deleted <title>" (or "<title> was deleted" without a name; the result is `returned` with `why: document_removed` and the record in `returned.removal`).
   Repeat in a No Work chat.
