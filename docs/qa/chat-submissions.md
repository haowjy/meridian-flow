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
