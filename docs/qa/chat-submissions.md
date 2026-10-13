# Writer message submission lifecycle

Use an owned worktree, database and **named agent-browser session** (never the
shared default browser). Start `MODEL_PROVIDER=mock pnpm dev`, discover HTTPS
URLs with `pnpm portless:list`, and sign in through dev-login. Use `./mf` for
fixtures and server readback. Keep screenshots, DOM, request traces and readback
JSON in the active work directory. These are manual runtime probes, not CI tests.

## Failure and recovery

1. Abort `**/api/projects/*/threads` with `agent-browser network route ... --abort`.
   Send from New chat. Expect one writer row, "Couldn't send.", one Retry, no
   assistant row, no load-error banner, and an empty editable composer. Unroute,
   click Retry once, and read `./mf thread view <id> --json`: one writer turn and
   one complete reply. The same thread id remains selected.
2. Repeat with `**/api/threads/*/messages` aborted. Creation succeeds; failure
   still belongs only to the writer row. Count requests while the row is failed:
   a local row status change must not invalidate snapshots and trigger a retry loop.
3. Force a real create 400: create a named Work through `./mf api POST
   /api/projects/<project>/works --data '{"name":"Probe"}'`, select it, then
   hold only the create POST with a disposable `window.fetch` wrapper. Send,
   archive that Work through `./mf api POST /api/works/<work>/archive`, then
   release the POST. Expect Retry and Edit on the writer row. Reload: no create
   or admission is retried. Edit returns the words to New chat in this pane.
4. Force a real admission 400 with a POST-only fetch wrapper that changes `text`
   but leaves `blocks` unchanged. Preserve and log the original body and the real
   400 response. Expect Retry and Edit. Reload: no admission or lookup is issued.
   Restore fetch and Retry once; server readback contains the original words once.
   Repeat in an existing chat; rejection has exactly the same presentation.
5. Send a normal second message in an existing chat. Composer clears immediately;
   server readback has the new writer turn once and a reply.

## Ordering, ownership and bounds

6. Hold only the first create POST before dispatch. Send another message in that
   chat while it is held. Both rows show Sending, no admission is posted early,
   and no assistant row exists. Release creation; server writer turns arrive in
   original send order. Capture the empty pre-admission snapshot to prove it did
   not remove optimistic writer rows.
7. While tab A holds creation, open the addressed chat in an independent tab B
   in the same browser context. B shows Sending, never failure due to ownership
   contention, and waits on the same Web Lock. Close A; B creates/reconciles and
   admits once. Read the server to rule out duplicate writer turns.
8. Hold a request beyond the 15-second deadline (an admission timeout may be
   followed by its own bounded lookup). Expect a local failed row and the lock
   released. Navigate away, restore ordinary fetch, then remount the chat: it
   reconciles and finishes rather than waiting forever on its previous owner.
9. Edit with newer writing preserves both structured drafts. For a never-created
   chat with two rejected messages and unsent text, Edit returns all three to
   New chat in order, ahead of any existing New chat writing, and replaces the
   vanished URL so Back cannot select it. A second tab moves only its own unsent
   draft after the journal retires. A message recorded after the dissolve's read
   still carries complete creation inputs and is not swept as an old record.

Remove every interception, close only the owned browser session, and stop only
this worktree's stack with `pnpm dev --stop`. Never describe a synthetic browser
403 as a real server rejection or a held-before-dispatch POST as a lost response
after a server commit.

## Deleted-chat server proof

Use an owned dev stack and a disposable chat. This checks HTTP availability,
not the later client move/navigation policy.

1. `./mf thread create --title "Deletion proof" --json`; save the id and project id.
2. `./mf api DELETE /api/threads/<id>`. With the same identity,
   `./mf api GET /api/threads/<id>/snapshot` must return HTTP 404 with
   `error.code = thread_deleted` and `error.details.authenticatedUserId`.
3. Repeat against GET and DELETE `/api/threads/<id>/admissions/<submissionId>`
   and POST `/api/threads/<id>/messages` (any JSON body). Each owner gate must
   return the same attested deletion code before reading/admitting anything.
4. Repeat creation with that id and valid Agent selection through both
   POST `/api/threads` and POST `/api/projects/<projectId>/threads`. Both must
   return attested `thread_deleted`, not resurrect the chat.
5. If a second dev account is available, authenticate it in a separate CLI
   cookie jar and compare that chat's snapshot refusal with a random missing
   UUID's refusal. The serialized envelopes must match byte-for-byte:
   `thread_not_found`, attested to the second account, no deletion disclosure.
6. Create a second disposable project and a live chat in it. Delete the project
   with DELETE `/api/projects/<projectId>`. Repeat the four thread gates and
   both existing-id creation routes: each returns `thread_deleted` with
   `details.projectDeleted: true` and the authenticated user id, even though
   the chat row itself is still live. Repeat with a trashed chat in that project.
7. GET `/api/projects/<projectId>` and both creation routes with a new chat id
   return HTTP 404 `project_deleted`, with `details.authenticatedUserId`.
   Missing projects and foreign projects (live or deleted) retain the identical
   generic `Project not found` refusal. Project DELETE remains idempotent;
   context availability explicitly reads tombstones and retains its policy.
8. A deleted chat in a live project, including a Work cascade, must have no
   `projectDeleted` field at all (not `false`).
9. Restore the disposable chat with POST `/api/threads/<id>/restore`, or leave
   it in trash. Do not change another worktree's identity or stack.

The DB gate contract also covers deleted parent projects, Work-cascade markers,
purges, and disagreeing creator/project-owner rows. Run it with
`pnpm test:db -- thread-deletion-proof`.

## Deleted-chat browser cleanup

Use the mock-model worktree and a named browser session. Seed a chat titled
"Arc 2 notes" with `./mf thread create --title 'Arc 2 notes'`. Abort only message
POSTs to produce a failed writer row ("Make the elder colder"), then type more
words in its box. Delete through `./mf api DELETE /api/threads/<id>`, remove the
abort, and click Retry. New chat must contain the failed row then the box text,
ahead of any older New chat writing, under the titled plural notice. Reload:
words and notice remain exactly once. Dismiss the X: words remain. Repeat and
Send: the note is gone and the new chat receives the words once.

Repeat with an untitled chat, a collapsed dock, the chat kept warm behind All
chats, and a dock covered by Changes or a document. Hidden chats move nothing.
For a visible chat's own Delete, nothing moves; successful DELETE clears the
journal and box. Delete a disposable parent project through the API: its chat's
attested project deletion clears without transfer or a note. A random missing
chat id must retain main's existing fallback and never run deletion cleanup.

Reload with journal records and session boxes for off-screen deleted and live
chats. The one bind pass clears only attested deleted destinations (up to four
requests concurrently, 15 seconds each). In two browser tabs, deleting in one
may remove the other's failed rows before that tab learns of deletion. This is
accepted: the other tab still moves its own box once it learns. No extra lock
prevents this rough edge.

Cold-load a deleted chat URL with both a failed row and saved box text: the bind
pass must defer that URL and the project's remembered dock chat until their panes
report deletion. The words move together with the note, not vanish. Open a chat
while bind cleanup waits on its submission lock: it must defer to that pane.
Restore a moved chat, write new box words at the same composer revision, then
delete again: the fresh words must move too. Refuse New chat storage or journal
enumeration: the chat stays, words remain, and Couldn't send replaces Sending.
Restore storage and Retry, Edit or wake: cleanup completes.

Hold a message POST open, start own Delete, then deliver its attested deletion
response before DELETE resolves: no words or notice move. A failed DELETE cancels
that own-delete intent; an account rebind must fence it. Attach a file into a
deleted project: the real error envelope reads "This project was deleted."

Capture the titled and untitled note in desktop Chat, a 360px dock, and a 390px
phone, each in light and dark. Crop out account identity and hide the TanStack
launcher. These captures verify real responsive wrapping, not fixture markup.

## Write-mode switch order

Start with `MODEL_PROVIDER=mock pnpm dev`, open a chat in the browser, and script a
reply with a long `delayMs` step (`./mf thread send <id> go --mock @script.json`).

1. Idle chat: choose the other mode in the composer. The control changes at once and
   the "Switched to…" divider follows.
2. During the reply: choose the other mode. A dashed "Switch to … queued" row with
   Withdraw sits at the tail; the divider replaces it after the reply ends.
3. During the reply: switch and switch back. Both rows disappear, no divider is
   written, and `GET /api/threads/<id>/snapshot` shows an empty pending inbox.
4. Abort `**/controls` in the browser (`agent-browser network route "**/controls" --abort`),
   switch, then send a message: the row says "Couldn't switch…" with Retry and no Withdraw (the
   request left, so the server may hold it), and the message stays "Sending". Remove the route and
   Retry: the row becomes queued and Withdraw appears; it withdraws on the server. Reload instead
   and the switch is admitted before the message.
5. Two tabs on one chat during a reply: switch in the typing tab. When the driving tab's answer
   retires the record, the other tab keeps the row and the chosen mode through the retirement.
6. A refused first send (`**/threads` returns 4xx) with a switch queued behind it: Edit returns to
   New chat with the message's draft and clears the switch.
7. New chat: pick a mode in the new-chat composer and send. The chat starts in it.
