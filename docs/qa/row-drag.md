# Row selection and drag

Named risks: a drop moves rows into the wrong catalog or folder, a folder lands
inside its own subtree, Undo leaves rows stranded, a drop target stays lit
after the drag ends, or a refused move or delete retries every 30s with the row
stuck at the destination and no error. This recipe is not a current pass claim.

## Setup

1. In an owned worktree, run `pnpm dev`; discover its HTTPS origins with
   `pnpm portless:list`.
2. Seed a project with `./mf`: Manuscript `Book 1/Part Two/Act 1` (empty) and
   `Book 1/Part Two/Act 2` holding `chapter-1`, `chapter-2`, `chapter-3`; a KB
   folder `characters` holding `keeper` and `mara`; a named Work with a chat
   bound to it; that Work's Scratch holding `research/Gate history`,
   `Bell timing` and `Scene notes` (`./mf doc put 'scratch://@<work>/...'`).
3. Open the owned app origin in `agent-browser --session row-drag`, sign in at
   `/dev-login`, and open `chapter-2` in the Editor.

Tool notes: agent-browser clicks don't carry held modifier keys, so send
selection gestures from the page:
`row.dispatchEvent(new MouseEvent('click', {bubbles: true, ctrlKey: true}))`
on the element with the row's `data-entry-key` (in Work Files, on the button
inside it, which owns the click). Native drags work with
`mouse move` / `mouse down` / several `mouse move` steps / `mouse up`; screenshot
between the moves to see the lit target and the pointer hint. The headless
browser reports no fine pointer, so rows render at touch height.

## Files tree

1. Ctrl-click `chapter-1` and `chapter-3` while `chapter-2` is open: all three
   rows fill. Ctrl-click `chapter-3` again: only it loses the fill. Shift-click
   selects the on-screen range from the last click. Escape returns to the open
   row.
2. Drag the selection over the collapsed Knowledge Base header: after about
   600 ms it opens, the header and its whole list light as one block, and the
   hint reads "Move to Knowledge Base".
3. Hover the closed `characters` folder until it opens, then hover `keeper`
   inside it: the folder and its rows light, the hint reads "Move to
   characters". Drop. The three chapters appear under `characters`, stay
   selected, and the open document's path reads Knowledge Base › characters.
   Between the tree and Scratch, the rail reads "Moved 3 items to
   characters." with Undo and Dismiss; it covers nothing and stays until the
   next move or Dismiss.
4. Press Undo: the chapters return to `Act 2`. Repeat with the keyboard (Tab
   to Undo, Enter) and with Dismiss: focus lands on a moved row, not the page
   body. Drop a row, then rename it: Undo leaves the notice and the message
   stays with Dismiss.
4a. Open a row's `…` menu, Move… it into a collapsed folder: the same notice
   names the destination; Undo returns it.
5. Drag `Part Two` onto `Act 2`: nothing lights, the hint reads "Can't go
   inside itself", and releasing changes nothing.
6. Drag a row over its own folder: no light, no hint, no change. Drag a
   Manuscript row over the User header, docked above Scratch: no light, no
   hint, no change (User is the writer's, in every project).
7. Drag `chapter-1` into a folder that already holds a `chapter-1`: the hint
   reads "Move to <folder>" with a warning line under it, "chapter-1 will be
   renamed chapter-1 (2)" (two clashing rows: "2 items will be renamed"). Move…
   shows the same line under that folder's Move action. Drop: the row arrives
   as `chapter-1 (2)`; the notice
   reads "Moved chapter-1 to <folder> as chapter-1 (2)." Undo puts it back as
   `chapter-1` (or the next free name if one took its place meanwhile).
8. Drag a row into the chat composer and into the open document: nothing is
   inserted (mention drops aren't built yet; no stray names as text).
9. After every drag, check that no region stays lit
   (`document.querySelectorAll('div[aria-hidden].-z-10').length === 0`).

## Refused moves and deletes

Named risk: a deterministic 400 from move or delete used to stay `submitted` and
POST again every 30s. The row sat at the destination with "Moved …" and no mark.

The app no longer sends a payload the server refuses, so rewrite the first
matching request in the page (`window.fetch`). Leave later POSTs unrewritten so
a resend would show as a second request.

- **Move:** on the first `POST …/context/manuscript/move`, parse the JSON body
  and set `destinationWorkId` to any UUID. The server answers 400
  "`destinationWorkId` is not valid for manuscript" as
  `{kind:"error", error:{code:"bad_request", retryable:false, …}}`.
- **Delete:** on the first `POST …/context/<scheme>/delete`, drop `expected`.
  The server answers 400 "expected target is required" with the same envelope.

One-shot move rewrite (swap the `if` for delete and `delete body.expected`):

```js
(() => {
  const o = window.fetch;
  let used = false;
  window.fetch = async function (u, i) {
    const url = String((u && u.url) || u);
    if (
      !used &&
      url.includes("/context/manuscript/move") &&
      i &&
      i.method === "POST" &&
      typeof i.body === "string"
    ) {
      used = true;
      const body = JSON.parse(i.body);
      body.destinationWorkId = "11111111-1111-4111-8111-111111111111";
      return o.call(this, u, { ...i, body: JSON.stringify(body) });
    }
    return o.apply(this, arguments);
  };
})();
```

1. Drag a Manuscript row into another folder with the move rewrite on. The row
   first shows at the destination, then returns to its source with the warning
   mark ("Couldn't move this entry. Try again."). The rail reads "Couldn't
   move <name>." with Dismiss and no Undo. Exactly one POST. After 35s and
   after a reload, still one POST. In IndexedDB
   (`meridian:resource-metadata:v4:<accountId>`, store `intents`) that intent is
   `needs-repair` with a refusal outcome, not `submitted`.
2. The same from the row's `…` menu, Move….
3. Multi-row drag with only the first request rewritten: the rail reads
   "Moved a to X. Couldn't move b." with Undo. Undo puts the moved row back.
   The refused row stays at its source with the mark.
4. Refused delete: the row comes back with "Couldn't delete this document.
   Try again." (folder: "Couldn't delete this folder. Try again."). Exactly one
   POST; no resend.
5. Control: an un-rewritten move and delete still succeed. Move shows
   "Moved …" with Undo; Undo works. Delete shows "Deleted …" with Undo and no
   mark.
6. Hover or focus the mark: `title` and `aria-label` are the mark copy above.
   No console errors beyond the expected 400s.
7. Successful move, then install the rewrite so it catches the reverse POST,
   then Undo: the notice hides at once. The row returns to the destination with
   the mark. The rail reads "Couldn't move <name> back." with Dismiss and no
   Undo. Exactly one POST; after 35s still one.
8. Undo without a rewrite: the notice stays gone after 40s.
9. After Undo, another move or delete on that surface before the reverse
   settles (hold the reverse response, then refuse it): the newer notice stays;
   "Couldn't move <name> back." does not replace it.
10. Two-row move, Undo with only the first reverse rewritten: "Couldn't move
    <name> back." The accepted reverse goes home; the refused row stays at the
    destination with the mark.

## Scratch and Work Files

1. Open the bound chat and expand Scratch in the sidebar. Drag `Bell timing`
   onto `research`: it opens, lights, and the note moves in with Undo.
2. Drag a Scratch note over a project folder: nothing lights and no hint shows
   (crossing between Scratch and the project is Move or Copy, not built yet).
3. Open the Work, then its Files tab, and collapse the sidebar. Select two
   notes inside `research` and drag them onto the Scratch heading: they move
   out, stay selected, and "Moved 2 items to Scratch." with Undo shows under
   the list. Undo puts them back. The sidebar's Scratch shows the same changes.

## Evidence

Record the commit, date, the screenshots for steps 2, 3, 5 and the Scratch and
Work Files drops, and any console errors, in the active work directory.
