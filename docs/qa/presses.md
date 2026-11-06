# Presses

This recipe checks the named risk that a click with no text under it puts the
caret somewhere the writer did not point: in another cell, inside a diagram's
hidden source, at the document start, or in a new paragraph nobody asked for.
It does not claim a current pass.

## Setup

Use a prose document at 1440×900 holding, in order: a paragraph long enough to
wrap to three lines, two paragraphs with a visible gap between them, a bullet
list, a table (with one cell holding two paragraphs), a rendered diagram, and
a paragraph. Make a second document that ends with a fenced code block, a third
that ends with a table, and a fourth that ends with a rendered diagram. Use
real mouse clicks; read the caret from a screenshot (the DOM does not show
which line a caret is on).

## Presses

1. **Margin.** Click in the left and right margin beside the wrapped
   paragraph, at each of its three lines. The caret goes to the end of that
   line when the click is right of it and to its start when left of it, never
   to the document start or end.
2. **Gap.** Click in the strip between the two paragraphs, near the upper one
   and near the lower one. The caret lands in the nearer paragraph, at the
   pointer's column. No paragraph is added.
3. **Wrapped line.** Click right of a wrapped line's last word. The caret
   blinks at that line's end, not at the next line's start. Click on a spot
   where the caret already stands: nothing changes.
4. **Cell padding.** Click the padding and borders of each cell, including the
   cell with two paragraphs, at its edges. The caret stays in the pressed cell
   every time. In a table wider than the pane, click the margin beside the
   clipped part: the caret goes to the last visible cell.
5. **Diagram and component block.** Click beside the rendered diagram, above
   and below its middle. The caret goes to the neighbouring paragraph's line
   (prose beats the diagram), the diagram stays rendered, and no source opens.
   Do the same beside a component block: the caret lands in the paragraph
   before or after it, never inside the block.
6. **Below each ending.** Click in the space below the last block of the first
   document: the caret goes to the end of the final paragraph. In the second,
   the caret goes to the fence's end. In the third, a gap cursor stands after
   the table. In the fourth, a gap cursor or the nearest prose; the diagram
   stays rendered. In every case the document is unchanged and its length
   the same: a press never makes a paragraph.
7. **Read-only.** Repeat 1 in a read-only view: no caret appears and nothing
   changes.

Record the commit, date, app URL, and a screenshot per step in the PR asset
directory.
