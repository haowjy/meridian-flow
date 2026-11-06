# Dragging a text selection

Named risks: a press on a highlight that redraws it instead of dragging (the browser's text
drag refuses a third click and, on macOS, waits), a drag that lifts but never lands or leaves
the source behind, a click that follows a link after a drag, an Escape that doesn't cancel, a
caret that vanishes while the pointer rests, and the composer or a second pane moving text
instead of copying it.

## Setup

An owned stack (`pnpm dev`, `pnpm bootstrap` first on a fresh worktree). In a throwaway project
seed `manuscript://Notes` and `manuscript://Shelf/Item` first, then `manuscript://Chapter 1`
with two long paragraphs (each three or more lines), a link line
(`[the notes](<manuscript://Notes>) and some words`), a 2×2 table and thirty filler paragraphs.
The link resolves only if its target exists when the chapter is created. Open the chapter and
expand the Shelf folder in the tree. Open it at 1440×900. Drive with a real mouse path (`agent-browser mouse
move/down/up` or CDP `Input.dispatchMouseEvent`; double and triple presses need an explicit
`clickCount`). Delete the project at the end.

## Steps

1. **Letters and gaps.** Sweep a range across two lines. Press on its letters, then on the space
   between its lines, and move 10px: both lift (the highlight stays, a caret follows the pointer,
   no drag image). A press right of the last highlighted word on a partly selected line, or on
   unselected text, does not. (A block the range covers whole may lift from its margin; a press
   there that doesn't travel still places a caret.)
2. **Move.** Release in another paragraph: the text moved and is still selected. Ctrl+Z puts it
   back in one step.
3. **No pause.** Press and move at once; it lifts the same.
4. **Double-click, then press.** Double-click a word and press its letters at once (third click)
   and move: the word moves.
5. **No travel.** On a selection, click: caret there. Double-click: the word. Triple-click: the
   paragraph.
6. **Copy.** Hold Ctrl (Option on a Mac) while dragging: a copy, source unchanged. Also press with
   Ctrl held and drag into the composer: the composer gets the text, the document keeps it.
7. **Escape.** Press Escape mid-drag: caret gone, nothing changed, the selection stays; moving
   on and releasing does nothing; a new drag works.
8. **Own range.** Release inside the dragged range: nothing changes.
9. **Link.** Select the link's text (it resolves to a document), press it, move a little and
   release on it: no navigation. Drag it onto the Shelf folder: the menu offers Move to Shelf,
   Copy to Shelf and Cancel. Drag it into the composer: "Mention", and a chip lands; the editor
   keeps the link.
10. **Composer.** Drag plain text to the composer: copied, source unchanged.
11. **Pause.** Hold still 6s over a spot: the caret stays; release lands there.
12. **Autoscroll.** Hold still within 32px of the pane's bottom: it scrolls on its own.
13. **Cells.** Select text inside a cell and drag it within the cell (moves) and out to a
    paragraph (moves). Sweep across two cells: a cell selection; pressing it is native.
14. **Fast.** Press a highlight and release inside 30ms of the first move, across several lines or
    in one fling with no pause: the text lands where the pointer was released.
15. **Quick re-press.** Right after sweeping a range, press its letters again (second click) and
    move: the range moves, no word is selected. Without moving, the press places a caret.
16. **Undo and redo.** After a move, Ctrl+Z puts the text back with the range selected at its
    old place; Ctrl+Shift+Z moves it again, selected; one more Ctrl+Z restores it again. Typing
    undo still leaves a caret.
17. **Into a touched block.** Sweep a range from mid-paragraph A to mid-paragraph B (also across a
    list item, a heading, a code block). Drop it in A's unselected head, then in B's unselected
    tail, and into a code block's unselected part: the text lands at the caret, nothing is lost or
    doubled, and Ctrl+Z restores text and highlight. A drop inside the range stays a no-op.
