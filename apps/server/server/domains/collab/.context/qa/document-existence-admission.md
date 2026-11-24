# A removed document takes no model write

Runtime checks for W52's write side: a model write to a removed document is returned with who
removed it, and a tab's typing into a trashed document is kept for Restore. Run on an owned mock
stack (`MODEL_PROVIDER=mock pnpm dev`); a tab is the browser or a Loro room client on `/ws/loro`
with the `./mf` dev cookie, and durable state is read with `psql` on this checkout's database.

Pauses use the dev-only hook controller: start the stack with
`HOOK_PAUSE_AT=<point>` and `HOOK_PAUSE_FILE=<file>`, create the file, and
the operation that reaches the point waits, with its locks, until the file is
deleted (`shared/test-hook-controller.ts`; points in `shared/test-hooks.ts`).

1. **Typing into a trashed document.** Open a document in a tab, `./mf doc rm` it from another,
   and type. PASS: the tab's batches are acked and the document's `document_snapshots` rows move;
   Restore shows the typing. Empty Trash for it: the tab's room ends `document-deleted` and its
   rows are gone.
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
4. **The receipt names who removed it.** Start the stack with
   `HOOK_PAUSE_AT=command.beforeClaim` (the edit must not hold the Work lock the
   delete needs). A draft-mode chat replaces a line; pause, `./mf doc rm` the document,
   resume. PASS: the write's result reads "Not in the document: this file was deleted by <name> and is in the trash, so this edit was not kept anywhere. It can be restored." (a name appears only when the user row
   has one: the dev auth bypass user has none, so set `users.name` after the delete and before
   resuming), and the chat's card reads "<name> deleted <title>" (or "<title> was deleted" without a name; the result is `returned` with `why: document_removed` and the record in `returned.removal`).
   Repeat in a No Work chat.
