# core/editor/objects — registration-driven object physics

What an editor object is, how it is selected, where keys apply, and whether Enter
engages a surface. Headless; object surfaces, dialogs and block-drag UI live in
features.

`EDITOR_OBJECT_TYPES` is the only object-ness and physics authority: never branch on
a node type elsewhere. A row also drives selection, pointer refusal, arrow walk,
Escape, drag mode and chrome context. Diagram rows are generated from the provider
catalog. Tables are selected with the full-cell `CellSelection` spelling that
`selectedObject` consumes; other objects use `NodeSelection`.

- Surface-bearing rows register their engagement handler by registration ID, not
  node type. Enter and double-click share one engagement door; `clickEngages` lets a
  click use it too (a capped picture opens on click). Every other object only
  selects.
- Object keymaps register with Chrome's scope and `appliesTo`; they don't inspect the
  selection again or create a priority-based TipTap extension.
- A press on a non-editable object body selects, so hidden source is never exposed.
  Inline-drag rows opt out so native inline dragging works.
- Selection rings are decorations derived from the current selection. Node-view
  `selectNode`/`deselectNode` cannot survive a remote whole-document rebuild.
- A rebuild restores a node selection by position alone. When it lands on a different
  node type, the object has gone and physics turns the selection into a caret, since
  a keystroke would replace the text it landed on.
- The arrow walk lands on an object or prose, never inside an opaque rendered body.
  A dead end is a refusal, not a backward jump.
- Destructive commands remove the registered node, not a table's cell selection. A
  block drag uses the block surface and `NodeHold`; inline drag uses ProseMirror.
- Keep table landing and press landing decisions in their shared helpers.

Row schema, selection and walk: [`.context/CONTEXT.md`](.context/CONTEXT.md). Related:
[chrome](../chrome/AGENTS.md), [diagrams](../diagrams/AGENTS.md),
[images](../images/AGENTS.md).
