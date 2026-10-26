# New folder: listed at once, settled in the background

Named risks: New folder waits for the server before the row appears; a folder made
offline is lost on reload or never lands; a document, folder or reorder put in a pending
folder is sent before the folder exists; a refused create loses the folder or its
contents silently; deleting a folder the server never saw sends a delete for nothing; two
tabs send the create twice. This recipe is not a current pass claim.

## Setup

1. In an owned worktree, run `pnpm dev`; discover its HTTPS origins with
   `pnpm portless:list`.
2. Seed a project with `./mf` (a Manuscript with a folder or two), sign in at
   `/dev-login` in `agent-browser --session folder-create` started with
   `--init-script <file>` holding the harness below, and open the Editor.

The harness logs each `create-folder` POST's start time to `localStorage.__cf` and holds
it `__delay` ms before it goes out. `localStorage.__refuse = '1'` swaps the folder id for
a non-UUID, which the server refuses typed (400 `invalid_operation`, `retryable: false`).
Install it once, as an init script only: a second install on top of it doubles the hold,
and a hold past 20s (`NAMESPACE_REQUEST_DEADLINE_MS`) makes every POST time out and
resend, which looks like a stuck create.

```js
(() => {
  const o = window.fetch;
  window.fetch = async function (u, i) {
    const url = String((u && u.url) || u);
    if (url.includes('/create-folder') && i && i.method === 'POST' && typeof i.body === 'string') {
      const log = JSON.parse(localStorage.getItem('__cf') || '[]');
      log.push(new Date().toISOString().slice(11, 19));
      localStorage.setItem('__cf', JSON.stringify(log));
      const delay = Number(localStorage.getItem('__delay') || 0);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (localStorage.getItem('__refuse')) {
        const body = JSON.parse(i.body);
        body.folderId = 'nope';
        return o.call(this, u, { ...i, body: JSON.stringify(body) });
      }
    }
    return o.apply(this, arguments);
  };
})();
```

Read the journal from IndexedDB (`meridian:resource-metadata:v4:<accountId>`): store
`folders` holds each folder's `canonical` (null until accepted) and `intents` (state and
request kinds), store `intents` holds documents'. A server read that needs no browser:
`./mf api GET /api/projects/<id>/context/catalog/snapshot?scheme=manuscript`.

## Steps

Use a `__delay` of `8000` to `14000` where a step says "hold". The Undo toast after a move
stays until dismissed and covers the lowest tree rows; dismiss it before the next drag.

1. Hold, press New folder, type a name, Enter. The folder is listed within a second while
   `__cf` shows one POST still unanswered; its `folders` record has `canonical: null` and
   a `submitted` intent. After the hold it lands with `canonical` set, the intent
   `settled`, and the server lists one folder at that name.
2. Offline: `agent-browser network route '**/create-folder' --abort`, create a folder,
   reload. The folder is still listed. `network unroute`; within 30s it lands. Repeat at a
   393×852 viewport.
3. Hold, create a folder, open its row menu and New file inside it. The document is listed
   under the folder and opens in the editor; its create waits (`pending`, predecessor the
   folder) until the folder lands, then goes out and settles.
4. Hold, create a folder, drag a row onto it (inside), and drag another row onto the lower
   edge of the folder (after). Both show at once. Each move waits on the folder (the
   second with `anchor: true` in its admission) and lands after it; the server shows the
   first inside the folder and the second ranked between the folder and its next sibling.
5. Refusal with contents: in a Manuscript folder `Dest`, hold and create `Doomed`, add a
   document and a folder in it, then delete `Dest` with `./mf api POST
   .../context/manuscript/delete` (`expected: {kind: "folder", nodeId}`) before the POST
   goes out. One POST answers 409 `destination_missing`. `Doomed` and both children are
   listed in Unfiled with a mark, each `needs-repair`; the document's identity bar offers
   "File it". Move… on `Doomed` to Manuscript lands it under the same id; the children keep
   their marks until placed. Nothing is resent.
6. Set `__refuse`, create a folder. One POST (still one after 35s and after a reload);
   the folder is `needs-repair` with a `refusal` outcome, listed in Unfiled with the mark.
   Clear `__refuse` and Delete the row: no POST, the delete is `settled-locally`, the
   create `superseded`, and there is no Undo.
7. Hold, create `Outer`, then a folder `Inner` inside it, and Delete `Inner` before `Outer`
   lands. `Inner` was never sent: no POST for it, its create `cancelled`, no Undo. Only
   `Outer` reaches the server.
8. Hold, create a folder and Delete it at once. The create was already sent, so it lands
   and the delete follows (`settled`, with an Undo toast); the server ends with no folder.
9. Hold, create a folder and rename it. One create POST, then the move; the server shows
   the new name only.
10. Two tabs on the project, the harness in both. Hold, create a folder in one. The other
    lists it within a second; `__cf` (shared) shows one POST; the server has one folder,
    with no `(2)` twin.

## Server refusals a folder create can get

Each is a typed 4xx envelope with `retryable: false`, so the app settles it once. Post a
body to `/api/projects/<id>/context/unfiled/create-folder` with `./mf api`.

| Body | Answer |
|---|---|
| body not an object; no `destination`; `destination.parent` of a bad kind | 400 `bad_request` |
| `folderId` not a UUID | 400 `invalid_operation` |
| bad `destination.name` | 400 `bad_request` |
| parent folder id unknown or deleted | 409 `destination_missing` |
| `uploads` root | 400 `invalid_uri` |
| `folderId` held by a document, or by a deleted, hidden or foreign folder | 409 `conflict` |

A replay of an accepted create answers `already-exists` and settles as accepted. A 401,
408, 429, any 5xx and a network failure stay retryable.
