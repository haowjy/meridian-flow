# Writer message submission lifecycle

Use an owned worktree, database and **named agent-browser session** (never the
shared default browser). Start `MODEL_PROVIDER=mock pnpm dev`, discover HTTPS
URLs with `pnpm portless:list`, (the stack runs with `DEV_AUTH_BYPASS=1`, so the app opens signed in). Use `./mf` for
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
   /api/projects/<project>/works --data '{"commandId":"<uuid>","name":"Probe"}'`, select it, then
   hold only the create POST with a disposable `window.fetch` wrapper. Send,
   archive that Work through `./mf api POST /api/works/<work>/archive --data '{"commandId":"<uuid>"}'`, then
   release the POST. Expect Retry and Edit on the writer row. Reload: no create
   or admission is retried. Edit returns the words to New chat in this pane.
4. Force a real admission 400 with a POST-only fetch wrapper that changes `text`
   but leaves `blocks` unchanged. Preserve and log the original body and the real
   400 response. Expect Retry and Edit. Reload: no admission or lookup is issued.
   Restore fetch and Retry once; server readback contains the original words once.
   Repeat in an existing chat; rejection has exactly the same presentation.
5. Send a normal second message in an existing chat. Composer clears immediately;
   server readback has the new writer turn once and a reply.

For the two real 400 cases, install the wrapper in the page before sending and
restore it after each case. It must preserve the original request and response
for the evidence:

```js
const fetch0 = window.fetch;
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("/threads") && url.includes("/messages")) {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    console.log("admission body", body);
    return new Response(JSON.stringify({ error: "probe admission refusal" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  return fetch0(input, init);
};
```

For the create case, hold the create POST before calling `fetch0`, then release
it after the browser has rendered both optimistic rows. A timeout is different:
hold the request past 15 seconds, let the local row fail, then release ordinary
fetch before remounting. Always set `window.fetch = fetch0` before the next case.

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

Use the same `fetch` wrapper to hold only the first create POST, without
returning a response. The second send must remain optimistic and no admission
request may run early. Release the promise, then read the server and confirm
the two writer turns are in send order. This is the ownership window; it is not
a lost response after a server commit.

Remove every interception, close only the owned browser session, and stop only
this worktree's stack with `pnpm dev --stop`. Never describe a synthetic browser
403 as a real server rejection or a held-before-dispatch POST as a lost response
after a server commit.

## Composer drafts

1. Open a seeded chat. Type prose and select an `@` reference. Reload before the
   250 ms debounce; both return. Open the chat in the Editor, type another draft,
   reload, and repeat on a phone viewport.
2. On `/chats` (a new chat in main), type into its composer and insert a reference. Reload;
   the project draft returns. Changing the prospective Work does not strand it.
3. Send a draft, reload while admission is pending and after acknowledgement;
   the journal/transcript owns the message and no duplicate composer draft returns.
   Start another unsent message and reload; the new words do return.
4. In two independent tabs, type different words and reload both. Each keeps its
   own draft. Close one and open a fresh tab; it starts empty.
5. Save a draft that references a file, delete it through `./mf doc rm`, and reload.
   Successful catalog acquisition removes the missing atom while keeping prose;
   offline or catalog errors keep the reference.
6. Reload during an upload: the in-flight upload atom drops, while a completed
   upload reference survives.

## Deleted-chat browser cleanup

With a failed writer row and saved composer text in a deleted chat, cold-load its
URL. Bind cleanup waits for the pane to report attested deletion, then moves the
row and words together into New chat exactly once. Restore the moved chat, type at
the same composer revision, delete it again, and confirm the fresh words move too.
If New chat storage or journal enumeration is refused, the chat stays in place
and words remain; restore storage and Retry, Edit or wake to finish cleanup.
