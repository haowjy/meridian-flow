# Refused document creates

Named risks: a create the server refuses is resent every 30s forever with only an
amber "Only on this device" chip on the document; the refused document loses its text,
or sits under a deleted destination; a dependent rename or delete queued behind it
never settles; a network drop is settled as a refusal and the document never lands; a
replay of a create the server already took is refused once its Work is archived, and
every repair under that id is refused after it; deleting a refused document destroys its
text with no Undo; the working-set sync replays a 400 for a document the server never
held; the failure sentence is cut on a phone, or never shown there; an id the server holds
out of reach (deleted, or its Work archived) is replayed forever and its repair refused with
it.
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

`__lose = '1'` lets the next create reach the server and throws away its answer (the
network error a lost response is), then sets `__hold`, which fails every later create at
the client without sending it. Clear `__hold` to let the replay out. `__refuse2 = '1'`
refuses every create under an id other than the first one logged, so a replaced id's retry
is refused while the original id still reaches the server. Reset `__cu` before a run: it
names the first id.

```js
(() => {
  const o = window.fetch;
  window.fetch = async function (u, i) {
    const url = String((u && u.url) || u);
    if (url.includes('/create-untitled') && i && i.method === 'POST' && typeof i.body === 'string') {
      const log = JSON.parse(localStorage.getItem('__cu') || '[]');
      const body = JSON.parse(i.body);
      log.push({ t: new Date().toISOString().slice(11, 19), id: body.documentId });
      localStorage.setItem('__cu', JSON.stringify(log));
      if (localStorage.getItem('__hold')) throw new TypeError('Failed to fetch');
      const delay = Number(localStorage.getItem('__delay') || 0);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const replaced = localStorage.getItem('__refuse2') && log.length > 1 && log[0].id !== body.documentId;
      if (localStorage.getItem('__refuse') || replaced) {
        body.documentId = '';
        return o.call(this, u, { ...i, body: JSON.stringify(body) });
      }
      if (localStorage.getItem('__lose')) {
        localStorage.removeItem('__lose');
        localStorage.setItem('__hold', '1');
        await o.apply(this, arguments);
        throw new TypeError('Failed to fetch');
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
   document. Try another place."); the identity bar shows the same sentence in full on a
   line under the path, with "Only on this device" and "File it" on the path line; the
   sentence is still in the editor after the reload. At 393×852 nothing is cut. In
   IndexedDB (`meridian:resource-metadata:v4:<accountId>`, store `intents`) the create is
   `needs-repair` with a `refusal` attempt outcome, never `submitted`.
2. Clear `__refuse`. "File it" opens the field with "Couldn't create this document.
   Try another place."; pick Manuscript and Enter. One more POST; the document lands in
   Manuscript with its text, the mark is gone, and the create is `settled`.
3. Repeat step 1, then use the row's menu: Move… (the picker says where it was meant
   to go) lands it; Rename files it at Unfiled under the new name.
4. Repeat step 1, then Delete the row. No POST; the row is gone, the delete is
   `settled-locally`, and the notice reads "Deleted Untitled" with Undo. Undo brings the
   row back with its text (one more POST, refused again while `__refuse` is set; the row
   returns to Unfiled with its mark). Without Undo the exact content is cleaned up after
   10 minutes (`cleanup.notBefore`).
5. Set `__delay` to `14000`, press New document, type, then immediately open "File it"
   and pick a folder before the held POST answers. When it is refused the queued move is
   `cancelled`, the create is `needs-repair`, no second POST goes out, and the row's
   Move… offers the folder you chose, and its picker is titled with the row's current
   name. The route tab that moved to the folder follows the document back to Unfiled and
   keeps the text and the mark; it never reads "This destination is unavailable."
6. Same hold, but Delete the row while the POST is held. After the refusal the delete is
   `settled-locally`, the create `superseded`, and nothing is pending.
7. Network drop: `agent-browser network route '**/create-untitled' --abort`, create a
   document and type. Two POSTs within a few milliseconds (the prepared attempt wakes the
   runner while it is in flight; see the app resources `FUTURE`), then one every 30s with
   no failure mark, only "Only on this device". `network unroute`; within 30s the create
   lands and the chip goes.
8. A real server refusal: abort creates as in step 7, press New file on a Manuscript
   folder, name it, delete that folder with `./mf api POST .../context/manuscript/delete`
   (`expected: {kind: "folder", nodeId}`), then `network unroute`. One POST answered 409
   `destination_missing`; the row is listed in Unfiled at its name (not under a folder),
   with the mark and no further POST. Move… to a live folder lands it.
9. Working set: with `__refuse` set and `__delay` at `14000`, press New document, type,
   "File it" to Manuscript. While the POST is held and after the refusal, the stored
   snapshot (`localStorage['meridian:working-set']`) has no route for the document, and the
   server log has no 400 for `/api/projects/:projectId/working-set`: a local-only
   document contributes no route. When the create lands, the projection clears `localOnly`
   and the next report adds the route.
10. A refused move's notice: stub the move request to fail (an `eval` that wraps
    `window.fetch` and posts `{}` to `/context/<scheme>/move`), Move… a server document to
    another folder, and read the sidebar notice "Couldn't move X." Rename X from another
    client (`./mf api POST .../context/manuscript/move` with `newName`). The notice leaves.
11. Position: a refused document dragged between two siblings keeps its slot when the
    repair create lands (the create carries `position`; see the server table below).

12. An id the server holds out of reach is replaced. Reset `__cu`, set `__lose`, press New
    file in Manuscript and name it. The document row is listed and one POST has gone out
    (`__cu` logs every attempt after it too, but none leaves the client). In IndexedDB the
    resource has `serverHold: "uncertain"`. Delete that document on the server with
    `./mf api POST .../context/manuscript/delete` (`expected: {kind: "file", documentId}`; an
    archived Work does the same), set `__refuse2`, clear `__hold`. The first replay answers 409
    `conflict`: the resource takes a new `identity.documentId` (revision 2, the old id in
    `aliases`), `serverHold` is `local`, and a retry under the new id is refused
    (`needs-repair`, the conflict create `superseded`). The row is listed in Unfiled with the
    mark. Clear `__refuse2`, Move… to Manuscript: one create under the new id lands, the
    server lists one document, the text is intact. Repeat to the refusal and Delete the row
    instead: `settled-locally`, no `/delete` request.
13. Upgrading a journal an older build wrote. In an open project, press New document, type a
    sentence with `__hold` set (the create is sent but never answered), then run the seeding
    snippet from the [E12 state evidence][e12-state] (`p15352-seed-v4.js`): it rewrites every row into the
    base build's shape (no `serverHold`, no `materialization`, the nameless create as a
    `create` desire) in a database at IndexedDB version 40. Clear `__hold`, `__cu`, reload.
    The database is at version 50; every record's `serverHold` equals what it was before the
    rewrite (`local`, `uncertain` or `held`); the nameless document is listed in Unfiled and
    its create is sent once, answered `created`, and the server reads back the sentence.
14. Phone refusal surface. `agent-browser` cannot render the phone shell (`set device` leaves
    `(pointer: coarse)` false, and every `agent-browser` command resets CDP emulation), so
    drive it over CDP from one script (`p15352-phone-repair.cjs` in the [E12 state evidence][e12-state]): `Emulation.setDeviceMetricsOverride`
    393×852 `mobile: true` and `Emulation.setTouchEmulationEnabled`, then reload. With a
    refused nameless document selected on the desktop (step 1), the phone's document screen
    reads "Couldn't create this document. Try another place." with Move… and Rename above the
    page; Rename opens the name field in place of the notice, Escape restores it; Move…
    opens the picker, and Manuscript → Move to Manuscript lands the document and the notice
    goes. In the Files list, Unfiled → each refused row says the sentence with Move… and
    Rename under its name (documents and folders), and Move… there lands it.

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

## A replay is answered from the id the server holds

A create has no receipt, so the route reads the document id before it checks authority on
the destination. With `./mf api`: create D in a Work's Scratch (`created`), post the same
body (`already-materialized`), archive the Work, then post the same body, a repair to
Manuscript and a nameless body under D. Each of the last three answers 409
`{status: "conflict"}`, which the app answers by minting a new id; none answers 403
`work_archived`. After `unarchive` the repair answers `already-materialized` at the Work's
Scratch. A deleted Work answers the replay 404 `work_missing` (a deleted Work resolves to
no authority, so its documents are not found) and the repair 409 `conflict`; both reach the
same remint.

An id held anywhere in the project answers from the row itself, not from the route's Work
authority: a replay whose Work was deleted is answered `409 {status: "conflict"}` from the
documents table, and a joined id is answered `joined` at the document its forward names. A
create with an id the project holds nowhere still resolves the route normally, so a fresh
create into a deleted Work is `404 work_missing` and a final refusal always means the server
holds no such id.

A create also takes `destination.position` (`{kind: "start" | "end" | "before" | "after",
siblingId}`), resolved under the move lock: an anchor the server does not hold places the
document last, a malformed position is a typed 400.

A refused folder create settles the same way, and its route reads the folder id before
checking authority in the same way; its recipe is [New folder](folder-create.md).

[e12-state]: https://github.com/haowjy/meridian-flow-docs/tree/main/work/drag-anywhere/evidence/e12-state
