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
   no drag image). The test is ProseMirror's own: the position under the pointer lies in the range.
   So a press on unselected text does not lift, wherever it is: after the range's last character
   on its last line, in a neighbouring cell, or on a new sweep begun beside the highlight (it starts
   a new selection). A block the range covers whole may lift from its margin; a press there that
   doesn't travel still places a caret.
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
    old place; Ctrl+Shift+Z moves it again and keeps y-tiptap's mapped selection; one more Ctrl+Z
    restores the old range selected again. Select a
    phrase and type over it: Ctrl+Z gives the phrase back selected. Typing
    undo still leaves a caret. The restored range scrolls into view when it was far away: after an
    autoscrolled move, Ctrl+Z brings the range on screen. Redo after a click elsewhere keeps that
    mapped caret or selection instead of choosing a range from the changed text.
17. **Into a touched block.** Sweep a range from mid-paragraph A to mid-paragraph B (also across a
    list item, a heading, a code block). Drop it in A's unselected head, then in B's unselected
    tail, and into a code block's unselected part: the text lands at the caret, nothing is lost or
    doubled, and Ctrl+Z restores text, blocks and highlight in one step. A drop inside the range stays
    a no-op. The lines stay lines: `# Chapter [1⏎Lorem ipsum.] Donec. | Vestibulum.` dropped at `|`
    gives `# Chapter`, `Donec.`, `1`, `Lorem ipsum. Vestibulum.` (four blocks; the blocks the range
    reached into keep their text and type, and nothing is left empty). Also try a range from a
    block's very start and one to its very end, a whole heading, and drops at a block's start and in
    an empty paragraph: the dropped range stays selected exactly. Copy three bullets, then four,
    including a nested list; every bullet and nested line stays in order and the source is
    untouched. Sweep three paragraphs in one quote and move them into prose: they remain one quote,
    without gaining another quote level. Drop a multi-line range in the gap between two paragraphs:
    it stays separate from the following paragraph. In both the first and second table row, sweep
    both paragraphs from one cell and move them out: the cell remains in its column with one empty
    paragraph. A range may cross table content when the move leaves every row and column in place; a
    move that would change the grid is refused, while a whole table moves as one block. Reload after
    each case, then undo and confirm the text, block types and highlight return.
18. **Every painted highlight.** Ctrl+A, then drag a little: the document is lifted and a drop on
    itself changes nothing; dragging it into the composer copies and leaves the document as it was.
    Sweep a range across several paragraphs and press in the blank past a line's last word: it lifts
    like a press on the letters; the same blank past the range's last line does not. A press in the margin beside a line outside the range stays native.
19. **Flick, and a button released out of order.** Drive raw CDP `Input.dispatchMouseEvent`, with no
    `mouseMoved` between press and release. Press a highlight and release 250px away: the text lands
    there and the click that follows reaches nothing. On a block handle, the same flick moves the
    block and opens no menu; on a diagram body it moves the block; on a table body it does nothing
    to the order. A handle press that wobbles 2px diagonally still opens the menu. Press the left
    button on a handle and move, press the right (`buttons: 3`), release the left (`buttons: 2`):
    the block drops at that point at once, and the right button's `pointerup` changes nothing.
    A touch tap on a highlight (`Input.dispatchTouchEvent`) places a caret and leaves the next
    press working.
20. **Lists.** In a list with a nested item, drag the handle of an item that has children
    below a later item: it moves with its children and keeps its depth; dropped
    below a plain paragraph it stays an item, and its child stays its child. Alt+↓ and Alt+↑
    step over the neighbouring item whole, children included, and never take another
    item's children. Duplicate and Delete in the handle's menu act on the item and its
    children. Copy a nested item's text alone: the clipboard text is the bare words; copy
    it with its line ends and the next item: `- one` / `- two`, not `- - one`. Paste a
    copied list into an empty line, into an item (the pasted items land beside it) and
    into another app (a plain `contenteditable` page shows nested bullets); paste a list
    copied from a web page or Google Docs: depth, numbering and checked boxes survive.
