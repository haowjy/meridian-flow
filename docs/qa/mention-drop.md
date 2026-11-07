# Mention drops

This recipe checks the named risk that a project-tree drag can promise one
landing and write somewhere else, split a word, move the source rows, or steal a
drop owned by another editor lane.

## Setup

Use a project with three short manuscript documents in one folder, a chat, a
prose document containing several paragraphs, a code block, and a table. Open
the document beside the Files tree and chat composer at 1440×900. Follow
[Row selection and drag](row-drag.md) to Ctrl/Cmd-select rows in screen order.
Use native mouse movement; synthetic `DragEvent` dispatch does not exercise
Chromium's hidden drag payload or ProseMirror's event order.

## References land where the caret promises

1. Put prose before and after the intended composer landing. Drag the three
   selected rows into the middle of a word. During the drag, the jade caret
   stands at the nearer word edge and the pointer hint reads **Mention**. Drop.
   Three standard reference chips appear in selection order, separated from
   each other and their neighbours by one space. One Undo removes all three and
   leaves the surrounding prose.
2. Repeat in a manuscript paragraph. The three chips match references inserted
   by `@`; dropping never opens one. Confirm the same word-edge snapping,
   spacing, order, focus, and one-step Undo.
3. Drag the folder by itself into both surfaces. Each drop writes one folder
   chip with the folder icon; the Editor link records its trailing-slash address.
   Select the folder and two chapters, then drag the selection into the composer.
   The three chips retain screen order even though moving the folder in the tree
   would subsume its selected children. Send the message and open its folder
   chip: the menu lists the folder's children.
4. Drop at a table-cell seam. The caret and insertion both resolve inside the
   nearest cell; the table keeps its row and column counts. Drop over a fenced
   code block: no caret appears, the hint reads **Can’t mention inside code**,
   and content does not change.
5. Drag a row the surface's `@` catalog cannot name, including an area root.
   The hint reads **Can’t mention that here** over the composer and the
   manuscript alike; content does not change.
6. Insert a multiword reference with `@`, then drop a row over the middle of
   its label. The caret snaps to the nearer outside edge and the whole original
   reference remains one chip after the drop. Repeat over a composer reference
   atom.
7. In the composer, type one character immediately after a drop. The first Undo
   removes only that character; the second removes every chip from the drop.

## Every point has a landing

Drag one row each time and read the caret during the drag, then the document
after the drop. Move the pointer once more and wait before reading the caret:
it trails the last move by one `dragover`.

8. **Gap between blocks.** Over the strip between two paragraphs: the caret
   draws there, and the drop makes a new paragraph holding the chip. If the
   gap borders an empty paragraph, the chip goes into it and no second blank
   line appears.
9. **Past the end.** Below the last block, in the reserve space: the drop makes
   a new last paragraph with the chip. (A press there never makes one; see
   [Presses](../../apps/app/src/core/editor/.context/qa/presses.md).)
10. **Margin.** In the left or right margin beside a paragraph: the chip lands
    on that paragraph's nearest line, never at the document start or end.
11. **Bullets.** Between two bullets, and in the gap above a list: the chip
    goes into the nearest bullet's line, not between items.
12. **Inline code.** Over the middle of a code span: the caret draws at the
    span's nearer edge and the chip lands there, outside the span. The hint
    reads **Mention**, not a refusal.
13. **Rendered diagram and component block.** Over a rendered diagram with the
    caret elsewhere: the caret draws at the seam before or after it by the
    pointer's half, and the chip gets its own paragraph. With the caret inside
    the diagram's source before the drag, the result is the same. A component
    block behaves the same way: the caret draws beside it, never inside, and
    the hint reads **Mention**.
14. **Empty document.** Over any point of a blank document: the chip lands in
    the one empty paragraph and no second paragraph appears.
15. **Files.** Drag a PNG over each of 8-14: it lands at the same place as the
    chip would, and the dashed **Drop to insert** overlay shows. A PDF lands
    there too, as a chip (see [Files dropped on a document](#files-dropped-on-a-document)).
    Over a fenced code block no caret draws and the hint reads **Can’t put a
    file inside code**.

## Text dropped in a table cell

16. Tables keep their grid. Drag a selection that runs from a paragraph into a
    second table onto a cell of the first table (a move, not a copy): the hint reads **Can’t move
    part of a table** and nothing changes, because deleting the selection would
    cut the second table. Drag the same selection onto a paragraph: the same
    hint. Hold Ctrl (Option on Mac) to copy onto a paragraph: it takes it. Drag a paragraph, a picture
    or a chip, with other text, onto a cell: it lands in the cell and both
    grids keep their row and column counts. Drag a selection onto its own
    range: nothing changes and no hint shows. A highlighted row of cells drags
    only the word under the browser's selection; that word lands in the
    cell like any text.

## Ownership and recovery

1. Repeat over a non-editable manuscript, such as an archived Work's note. The
   editor shows no caret or hint, does not set a copy cursor, and changes
   nothing.
2. While a valid drop is hovering, press Escape. The caret and hint disappear;
   neither writing surface nor tree changes.
3. After every writing drop, read the three source addresses again and confirm
   no row moved and no move notice appeared.
4. Drop an OS image file and move a manuscript block with its grip. Both retain
   their existing cursor, landing, and Undo behavior; a row drop never carries
   `Files` and never claims `view.dragging`.

Record the commit, date, app URL, screenshots of the composer caret/result,
editor caret/result, and both refusal states, plus browser errors, in the active
work directory or the PR asset directory.

## Files dropped on a document

Use a prose document in each of Manuscript and Knowledge Base, one with a heading, a list and a
table. A synthetic `DragEvent` carrying a `DataTransfer` with `File`s works for these: the browser's
own file drag adds nothing to what the door reads. Read the rows from `upload_intakes` or the tree.

1. Drop a PDF at a word, in a heading, in a list item and in a table cell. Each lands a chip at
   the caret reading the name, then `PDF · 2 KB` once it finalizes. The file is a row in
   `<source>://assets/` of the document's own source (Knowledge Base: `kb://assets/`), and the chip
   opens it the way the tree's row does. Drop the same name again: `name (2).pdf`; a `.zip` keeps its
   extension (`notes (2).zip`).
2. Drop a PDF, a picture and a second PDF together. They land in that order, the picture in its own
   lane (`manuscript://assets/`). The two PDFs and any run of chips between pictures are one edit:
   one Undo.
3. Include a file over 200 MB with others. Only that one is refused, with
   **name is over 200 MB, so it can't be added.**; nothing is inserted or sent for it.
4. Drop a 200 MB file and watch the chip: it fills left to right and reads `Uploading n%`, and
   settles to `BIN · 200 MB`. In a second tab, the chip reads `Uploading` while the bytes arrive
   and flips with no reload when the file finalizes. A reload mid-upload reads `Uploading` for as
   long as the server holds the intake, then `gone` if the page took the upload with it.
5. Undo while it uploads. The chip leaves, and about ten seconds later the request is aborted: no
   object stays and the intake row stays `reserved` until the sweep, reading `gone` after three
   minutes. Cut the chip and paste it back within a few seconds: the upload
   keeps going. Paste it into another document after the abort: it reads gone.
6. While one uploads, rename `assets/`. The file lands in a fresh `assets/` and the chip follows
   it by id. Rename or move a finished file, then read the document through `./mf doc read`: the
   link shows the file's current path. Trash a finished file and click its chip: Trash opens at it.
   Drop a text file (`.md`): it becomes a document in `assets/`, and a notice says so and that the
   chip links to it. Several of one name dropped at once get `name`, `name (2)`, `name (3)`.
7. A read-only editor (`setEditable(false)`) takes no file and starts no upload.
8. Export the project: the files sit under their folders and the document's link points at the
   current path.

Not covered by a live run: Scratch of a chat's lineage (the route builds the lineage container the
create route uses, but no chat in the probe project had a lineage to write to).
