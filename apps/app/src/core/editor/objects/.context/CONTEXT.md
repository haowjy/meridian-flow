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
decorations, not node-view callbacks that a remote rebuild can lose.

## Arrow movement and Escape

The movement helpers in [object-selection.ts](../object-selection.ts) check each
landing against object registration. Schema-aware `Selection.near` alone cannot
distinguish hidden diagram source from visible prose.

An arrow asks for the adjacent object and may stop at a dead end. Escape searches
forward for writable prose, skipping opaque objects; a gap after a trailing object
is a valid destination. It looks behind only when nothing is ahead, and can create
a paragraph when the object is the whole document. These searches stay inside the
nearest isolating ancestor, so leaving an object in a cell does not jump to another
cell.

A plain code fence is not an object. Enter on its NodeSelection takes the caret to
its start and consumes the key so the base keymap cannot split it. That binding
uses Chrome's block scope, as do arrows approaching an object from prose.

A remote rebuild may restore a NodeSelection by position. If a different node type
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
`insertText` handler use the same ProseMirror `handleTextInput` chain. The
`compositionstart` handler prepares the destination, then leaves provisional text
and commit to the browser. It must run before ProseMirror's own compositionstart
handler, which calls `endComposition` with `restarting` set for a nonempty
selection. That path deletes a non-inline selection, removing a selected block or
emptying a selected table's cells. Waiting for `beforeinput` is too late. Ordinary
text and partial cell selections keep their existing input paths.
