# Refused document creates

Named risks: a create the server refuses is resent every 30s forever with only an
amber "Only on this device" chip on the document; the refused document loses its text,
or sits under a deleted destination; a dependent rename or delete queued behind it
never settles; a network drop is settled as a refusal and the document never lands.
This recipe is not a current pass claim.

## Setup

1. In an owned worktree, run `pnpm dev`; discover its HTTPS origins with
   `pnpm portless:list`.
2. Seed a project with `./mf`: a Manuscript folder `Book` holding a chapter, a named
   Work, and a chat.
3. Sign in at `/dev-login` in `agent-browser --session refused-create` started with
   `--init-script <file>` holding the harness below, and open the Editor.

The app never sends a create the server refuses, so the harness blanks `documentId`
on a create-untitled POST (the server answers a typed 400 `bad_request`,
`retryable: false`). It also logs every POST to `localStorage.__cu`, and holds each one
`__delay` ms, so a request count and an in-flight window survive reloads. Set
`localStorage.__refuse = '1'` to refuse, `localStorage.__delay = '9000'` to hold.

```js
(() => {
  const o = window.fetch;
  window.fetch = async function (u, i) {
    const url = String((u && u.url) || u);
    if (url.includes('/create-untitled') && i && i.method === 'POST' && typeof i.body === 'string') {
      const log = JSON.parse(localStorage.getItem('__cu') || '[]');
      log.push(new Date().toISOString().slice(11, 19));
      localStorage.setItem('__cu', JSON.stringify(log));
      const delay = Number(localStorage.getItem('__delay') || 0);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (localStorage.getItem('__refuse')) {
        const body = JSON.parse(i.body);
        body.documentId = '';
        return o.call(this, u, { ...i, body: JSON.stringify(body) });
      }
    }
    return o.apply(this, arguments);
  };
})();
```

## Steps

1. Set `__refuse`, reset `__cu` to `[]`, press New document and type a sentence.
   Exactly one POST (`__cu` has one entry), still one after 70s and after a reload.
   The Unfiled row reads "Untitled" with the warning mark ("Couldn't create this
   document. Try again."); the identity bar shows the same mark beside "Only on this
   device" and "File it"; the sentence is still in the editor after the reload. In
   IndexedDB (`meridian:resource-metadata:v4:<accountId>`, store `intents`) the create is
   `needs-repair` with a `refusal` attempt outcome, never `submitted`.
2. Clear `__refuse`. "File it" opens the field with "Couldn't create this document.
   Try another place."; pick Manuscript and Enter. One more POST; the document lands in
   Manuscript with its text, the mark is gone, and the create is `settled`.
3. Repeat step 1, then use the row's menu: Move… (the picker says where it was meant
   to go) lands it; Rename files it at Unfiled under the new name.
4. Repeat step 1, then Delete the row. No POST; the row is gone, the delete is
   `settled-locally` and the exact content is cleaned up.
5. Set `__delay` to `14000`, press New document, type, then immediately open "File it"
   and pick a folder before the held POST answers. When it is refused the queued move is
   `cancelled`, the create is `needs-repair`, no second POST goes out, and the row's
   Move… offers the folder you chose. (The route tab for that destination can read
   "This destination is unavailable." until reloaded; see the app resources `FUTURE`.)
6. Same hold, but Delete the row while the POST is held. After the refusal the delete is
   `settled-locally`, the create `superseded`, and nothing is pending.
7. Network drop: `agent-browser network route '**/create-untitled' --abort`, create a
   document and type. POSTs repeat every 30s with no failure mark, only "Only on this
   device". `network unroute`; within 30s the create lands and the chip goes.
8. A real server refusal: abort creates as in step 7, press New file on a Manuscript
   folder, name it, delete that folder with `./mf api POST .../context/manuscript/delete`
   (`expected: {kind: "folder", nodeId}`), then `network unroute`. One POST answered 409
   `destination_missing`; the row is listed in Unfiled at its name (not under a folder),
   with the mark and no further POST. Move… to a live folder lands it.

## Server refusals a create can get

Each is a typed 4xx envelope with `retryable: false`, so the app settles it once.
Post a body to `/api/projects/<id>/context/unfiled/create-untitled` with `./mf api`.

| Body | Answer |
|---|---|
| `documentId` empty, not a UUID, or body not an object | 400 `bad_request` or `invalid_operation` |
| `destination` not an object; bad `name`; bad `createFolders`; bad parent kind | 400 `bad_request` |
| parent folder id unknown or deleted | 409 `destination_missing` |
| root owner `workId` not a UUID | 400 `bad_request` |
| root owner `workId` of a deleted Work | 404 `work_missing` |
| root owner `workId` of an archived Work, Scratch | 403 `work_archived` |
| root owner `rootThreadId` of no chat; a chat owner on a scheme but Scratch | 404 `not_found`; 400 `bad_request` |
| `uploads` root | 400 `invalid_uri` |

A 401 (expired session), 408, 429, any 5xx and a network failure stay retryable.

A refused folder create settles the same way; its recipe is [New folder](folder-create.md).
