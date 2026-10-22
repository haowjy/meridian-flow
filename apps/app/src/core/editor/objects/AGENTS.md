# core/editor/objects — registration-driven object physics

This directory answers what an editor object is, how it is selected, where
keys apply, and whether Enter engages a surface. It is headless; object
surfaces, dialogs, and block-drag UI live in features.

## Mental model

`EDITOR_OBJECT_TYPES` is the sole object-ness and physics authority. A row names
the node/registration ID, body mode (`text`, `block-drag`, or `inline-drag`),
engagement, surface fields, and optional matches predicate. Diagram rows are
generated from the provider catalog. Never branch on a node type elsewhere.

The row also drives selection, pointer refusal, arrow walk, Escape, drag mode,
and resolved chrome context. `NodeSelection` selects ordinary objects;
tables use the full-cell `CellSelection` spelling consumed by
`selectedObject`.

## Rules

- Surface-bearing rows register their engagement handler by registration ID,
  not node type. Enter and double-click use the same engagement door; a newly
  created object may open ready to edit, while an existing one shows its state.
- Object keymaps register with Chrome's scope and `appliesTo`; they do not
  inspect selection again or create a priority-based TipTap extension.
- A pointer on a non-editable object body selects on press so hidden source is
  never exposed. Inline-drag rows opt out so native inline dragging remains
  possible. Click selection still uses ProseMirror's normal mouse path.
- Selection rings are decorations derived from current selection. Node-view
  `selectNode`/`deselectNode` cannot survive a remote whole-document rebuild.
- The arrow walk lands on an object or prose, never inside an opaque rendered
  body. Esc and printable input step over an opaque object to the next writable
  position; a dead end is a refusal rather than a backward jump.
- `typeBesideObjectTransaction` inserts beside a selected object. Destructive
  commands remove the registered node, not a table's cell selection. A block
  drag uses the block surface and `NodeHold`; inline drag uses ProseMirror.
- Keep table landing and pointer-boundary decisions in their shared helpers.
  A structural drop must resolve inside a cell rather than manufacture a
  column.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — row schema, selection, and walk
→ [`../chrome/AGENTS.md`](../chrome/AGENTS.md) — key and Escape policy
→ [`../diagrams/AGENTS.md`](../diagrams/AGENTS.md) — generated diagram rows
→ [`../images/AGENTS.md`](../images/AGENTS.md) — image object surface
