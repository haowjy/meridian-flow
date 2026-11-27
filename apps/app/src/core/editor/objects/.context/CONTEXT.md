# Object selection and input contracts

`EDITOR_OBJECT_TYPES` in [object-types.ts](../object-types.ts) registers the nodes
that behave as objects rather than editable prose. An `inline-drag` registration
must use a schema-inline node whose view exposes `data-drag-handle`; a block figure
cannot be dragged between words like an inline image.

`surfaceFields` lists the attributes an object's dialog may edit. A registration
with `engage: "surface"` needs a `registerObjectEngagement` handler in
[ObjectPhysicsExtension.ts](../ObjectPhysicsExtension.ts). Enter is consumed even
without a handler so it cannot fall through and split a selected object.

## Selection and pointer

`selectObjectTransaction` may request a NodeSelection for a table because the table
plugin normalizes it to a full-table CellSelection. A partial CellSelection means
the writer is editing cells, not selecting the table as an object; typing replaces
those cells.

The mousedown listener sits beside, not inside, ProseMirror's click machinery so
click-to-select does not break double-click-to-open. Selection rings come from
decorations, not node-view callbacks that a binding re-read can lose.

## Arrow movement and Escape

The movement helpers in [object-selection.ts](../object-selection.ts) check each
landing against object registration. Schema-aware `Selection.near` alone cannot
distinguish hidden diagram source from visible prose.

An arrow asks for the adjacent object and may stop at a dead end. Left and
right walk onto it from the block's first or last character; up and down from
its first or last line (`endOfTextblock`), since the browser's own vertical
move cannot enter an opaque object and, with nothing after it, does nothing. Up and
down never take the next cell in a row, which is to the right on screen, not below:
the table's own arrows move between rows, and the walk looks past the table only from
its first or last row. Escape searches
forward for writable prose, skipping opaque objects; a gap after a trailing object
is a valid destination. It looks behind only when nothing is ahead, and can create
a paragraph when the object is the whole document. These searches stay inside the
nearest isolating ancestor, so leaving an object in a cell does not jump to another
cell.

A plain code fence is not an object. Enter on its NodeSelection takes the caret to
its start and consumes the key so the base keymap cannot split it. That binding
uses Chrome's block scope, as do arrows approaching an object from prose.

A binding re-read may restore a NodeSelection by position. If a different node type
now occupies that position, the extension changes it to a text caret; otherwise
typing would replace unrelated text. An adjacent object of the same type remains
selected, with its ring visible.

A press or drop beside a plain code fence takes its facing text edge when there
is no prose on the other side. The [landing helpers](../../landing/press.ts) own
that choice; object selection must not turn this editable edge into a dead end.

## Typing

`typeBesideObjectTransaction` prepares writable text after the selected object,
using existing prose or making a paragraph. It does not insert characters. The
`ObjectPhysicsExtension` text-input handler adds the committed text to that
transaction. This is also the policy for a fully selected table: type after the
table, preserving its cells.

Physical keypresses and the extension's cancelable, non-composing `beforeinput`
`insertText` handler use the same ProseMirror `handleTextInput` chain, for every
selection that is not a text caret (a selected object, a gap cursor, a cell
selection). Text input with no keypress (IME commits, dictation, mobile keyboards,
CDP `insertText`) otherwise goes to the browser's own caret, which can disagree
with the model: after a click below a final table, Chrome's caret stays inside
the table's wrapper, which ProseMirror counts as the gap cursor's position, and
the text went into the last cell. The
`compositionstart` handler prepares the destination, then leaves provisional text
and commit to the browser. It must run before ProseMirror's own compositionstart
handler, which calls `endComposition` with `restarting` set for a nonempty
selection. That path deletes a non-inline selection, removing a selected block or
emptying a selected table's cells. Waiting for `beforeinput` is too late. Ordinary
text and partial cell selections keep their existing input paths.

Before input starts, `objectSelectionForDOM` gives an editable view a collapsed
native caret: after an inline object, or at the last visible text position inside
a text-body object. It skips opaque bodies and never searches outside the selected
object. Registration `body: "text"` means editable object content (tables);
`body: "block-drag"` means an opaque block (rules, figures and rendered diagrams).
Inline images use `body: "inline-drag"` and the trailing-caret rule. The model still
holds the NodeSelection or full CellSelection, so commands,
clipboard contents and rings keep selecting the object. Chromium otherwise adopts
the nonempty native range before `compositionstart` and can restart composition,
leaving provisional text beside the committed text.

The native caret and the `compositionstart` preparation are both needed. The
latter finds following prose or creates a paragraph; without it, typing on a
selected table would land inside its last cell. The rich-document schema permits
that paragraph. Under a constrained schema whose document can contain only a
table, the helper cannot prepare prose after it; ProseMirror can then read back
the projected caret and input lands inside the table instead. Browser selection
changes can also read that caret into the model, so the projection must always be
a valid editing position. Read-only views, opaque block objects and partial cell
selections keep their normal native range.

Shift-extension is a range operation, not typing. The object-scoped keymap prepares
a directed TextSelection that includes the selected inline object, then leaves the
extension to the browser. Shift-click uses the same transaction in `mousedown`,
before ProseMirror starts deferring native selection updates for a drag. Preparing
it in the later object-press listener would leave the projected caret in the DOM
and exclude the image. Keys handled by the table plugin keep their cell-grid
selection behavior. Only after the table plugin and ProseMirror's own key capture
decline does the Chrome native route restore the selection's `$anchor`/`$head` as a
text range. These endpoints describe the range ProseMirror would render without
projection, not the corners of the selected cell rectangle. Modified PageUp/Down
shortcuts are not converted: some act on browser tabs rather than extending text.

Table pointer preparation sits in [table-press.ts](../../landing/table-press.ts),
after the stock table handlers and the inert-cell press claim, but before
ProseMirror's native drag setup. Thus stock Shift-click still selects cells, while
unclaimed Ctrl/Meta+Shift-click starts from the model's text endpoints. The early inline
image pointer handler must not convert a cell selection.
