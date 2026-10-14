# Row selection and drag

Named risks: a drop moves rows into the wrong catalog or folder, a folder lands
inside its own subtree, Undo leaves rows stranded, or a drop target stays lit
after the drag ends. This recipe is not a current pass claim.

## Setup

1. In an owned worktree, run `pnpm dev`; discover its HTTPS origins with
   `pnpm portless:list`.
2. Seed a project with `./mf`: Manuscript `Book 1/Part Two/Act 1` (empty) and
   `Book 1/Part Two/Act 2` holding `chapter-1`, `chapter-2`, `chapter-3`; a KB
   folder `characters` holding `keeper` and `mara`; a named Work with a chat
   bound to it; that Work's Scratch holding `research/Gate history`,
   `Bell timing` and `Scene notes` (`./mf doc put 'scratch://@<work>/...'`).
3. Open the owned app origin in `agent-browser --session row-drag`, sign in at
   `/dev-login`, and open `chapter-1` in the Editor.

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
   The sidebar foot reads "Moved 3 items to characters." with Undo.
4. Press Undo before the notice leaves: the chapters return to `Act 2`.
5. Drag `Part Two` onto `Act 2`: nothing lights, the hint reads "Can't go
   inside itself", and releasing changes nothing.
6. Drag a row over its own folder: no light, no hint, no change.
7. Drag a row into a folder that already holds that name: the hint reads
   "<folder> already has <name>", and releasing changes nothing.
8. After every drag, check that no region stays lit
   (`document.querySelectorAll('div[aria-hidden].-z-10').length === 0`).

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
