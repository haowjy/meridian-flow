# Mention drops

This recipe checks the named risk that a project-tree drag can promise one
landing and write somewhere else, split a word, move the source rows, or steal a
drop owned by another editor lane.

## Setup

Use a project with three short manuscript documents in one folder, a chat, a
prose document containing several paragraphs, a code block, and a table. Open
the document beside the Files tree and chat composer at 1440×900. Follow
[Row selection and drag](row-drag.md) to Ctrl/Cmd-select the three document rows
in screen order. Use native mouse movement; synthetic `DragEvent` dispatch does
not exercise Chromium's hidden drag payload or ProseMirror's event order.

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
3. Drop at a table-cell seam. The caret and insertion both resolve inside the
   nearest cell; the table keeps its row and column counts. Drop over a code
   block: no caret appears, the hint reads **Can’t mention there**, and content
   does not change.
4. Drag a row the surface's `@` catalog cannot name. The hint reads **Can’t
   mention that** and content does not change. On the documents-only build this
   includes folders; there is no folder-specific drop rule.

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
