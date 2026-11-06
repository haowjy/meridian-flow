# Row selection and drag

Named risks: a drop moves rows into the wrong catalog or folder, a folder lands
inside its own subtree, a drop target stays lit
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
   No toast and no card: the tree is the whole report. Repeat on a phone from a
   row's Move…: same result, nothing else appears.
4a. Open a row's `…` menu, Move… it into a collapsed folder: the row leaves its
   place and no toast shows.
5. Drag `Part Two` onto `Act 2`: nothing lights, the hint reads "Can't go
   inside itself", and releasing changes nothing.
6. Drag a row over its own folder: no light, no hint, no change. Drag a
   Manuscript row over the User header, docked above Scratch: no light, no
   hint, no change (User is the writer's, in every project).
7. Drag `chapter-1` into a folder that already holds a `chapter-1`: the hint
   reads "Move to <folder>" with a warning line under it, "chapter-1 will be
   renamed chapter-1 (2)" (two clashing rows: "2 items will be renamed"). Move…
   shows the same line under that folder's Move action. Drop: the row arrives
   as `chapter-1 (2)`; no toast shows.
8. Run [Mention drops](mention-drop.md). A writing drop copies references and
   never enters this recipe's move route.
9. After every drag, check that no region stays lit
   (`document.querySelectorAll('div[aria-hidden].-z-10').length === 0`).

## Reorder within a folder

Named risks: an edge drop lands somewhere other than the line showed, the folder
region steals an edge, a stale verdict or spring survives moving between edges,
a search-hidden sibling is ignored, or several rows land out of order.

Seed `Act 1` holding `Interludes` (a folder with two notes) and `Chapter 1`,
`Chapter 2`, `Chapter 3`, `Chapter 4`, `Chapter 10`; a collapsed `Act 2` holding
`Chapter 11`, `Chapter 12`; root `Prologue` and `Epilogue`. Rows are 44 px in the
headless browser: a file's edge band is its top or bottom third, a folder's its
top or bottom quarter.

1. Drag `Chapter 10` to the top band of `Chapter 2`: a line at `Chapter 2`'s
   indentation, no fill on `Act 1`, the hint reads "Move before Chapter 2".
   Move to its centre: nothing lights (it is already in `Act 1`). Move to the
   bottom band of `Chapter 3`: "Move after Chapter 3". Drop: it lands there.
2. Drag `Prologue` over open `Act 1`: its top band reads "Move before Act 1"
   with the line at root indentation; its centre lights the whole folder,
   "Move to Act 1". The top band of `Act 2` reads "Move before Act 2", the line
   below `Act 1`'s subtree; a collapsed folder's bottom band reads "Move after
   Act 2". Drop on "before Act 1": `Prologue` lands there.
3. Ctrl-select `Chapter 2` and `Chapter 4` and drop them on the bottom band of
   `Chapter 1`: they land after it in screen order. Dragging a selection onto an edge of
   one of its own rows does nothing.
4. Hover `Act 2` until it springs open, then the bottom band of `Chapter 11`
   and drop: it sits between 11 and 12.
5. Drag `Act 1` onto an edge of a row inside it: "Can't go inside itself", no
   line, no change.
6. In a Work's Files, search `o` so `Bell timing` hides between `Bell rope` and
   `Bell tower`. Drag `Bell tower` to the bottom band of `Bell rope`: the line
   and "Move after Bell rope" show (the hidden row counts). Clear the search:
   the order is rope, tower, timing.
7. With a short viewport (1440×560), hold a drag in the tree's bottom 32 px
   until it scrolls, then drop on an edge of a row scrolled into view: it lands
   beside that row.
8. A second client sees each reorder without a reload.
9. Escape: the headless drag ignores the key, so dispatch
   `window.dispatchEvent(new Event('dragend'))` mid-drag; the line and hint go.
10. Move… on a chapter (desktop keyboard: focus its `…`, Enter, type `m`,
    Enter, End, Enter): its own folder offers "Change position", which
    lists "Move to the top of Act 1", "Move after <sibling>" and "Move to the
    bottom of Act 1", minus the place it holds. Choose one: the row moves and
    focus returns to the row. Repeat on the phone
    (393×852, coarse pointer per [Chat Files](chat-files.md)); its rows are
    not draggable.

## Refused moves and deletes

Named risk: a deterministic 400 from move or delete used to stay `submitted` and
POST again every 30s. The row sat at the destination with no mark.

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
   mark ("Couldn't move this entry. Try again."). A toast at the top right reads
   "Couldn't move <name> to <folder>." with Retry and a close button, and stays
   until closed. It covers no tree row. Exactly one POST. After 35s and after a
   reload, still one POST; the reload shows the mark and no toast. In IndexedDB
   (`meridian:resource-metadata:v4:<accountId>`, store `intents`) that intent is
   `needs-repair` with a refusal outcome, not `submitted`.
2. The same from the row's `…` menu, Move…. Retry with no rewrite: the row moves,
   the mark and the toast go.
3. Multi-row drag with only the first request rewritten: the other row lands and
   the refused row stays at its source with the mark. With every request rewritten
   the toast reads "Couldn't move 3 items to <folder>." and Retry moves all three.
4. Refused delete: the row comes back with "Couldn't delete this document.
   Try again." (folder: "Couldn't delete this folder. Try again.") and the toast
   "Couldn't delete <name>." with Retry. Exactly one POST; no resend. Retry deletes it.
5. Each refusal has its own toast: refuse a move, a delete, a Copy and a second move.
   Three show, and closing one brings up the fourth. Refuse a move, rename the row, and
   the toast closes. Refuse a move,
   press Retry after renaming from another client: nothing happens to the row.
6. Control: an un-rewritten move and delete succeed with no toast and no mark.
7. Hover or focus the mark: `title` and `aria-label` are the mark copy above.
   No console errors beyond the expected 400s.
8. On a phone the toast sits under the top bar, full width.

## Scratch and Work Files

1. Open the bound chat and expand Scratch in the sidebar. Drag `Bell timing`
   onto `research`: it opens, lights, and the note moves in.
2. Drag a Scratch note over a project folder: nothing lights and no hint shows
   (crossing between Scratch and the project is Move or Copy, not built yet).
3. Open the Work, then its Files tab, and collapse the sidebar. Select two
   notes inside `research` and drag them onto the Scratch heading: they move
   out and stay selected. The sidebar's Scratch shows the same changes.

## Evidence

Record the commit, date, the screenshots for steps 2, 3, 5, the reorder steps
1, 2, 6 and 10, and the Scratch and Work Files drops, and any console errors, in
the active work directory.
