# Editor — TODO

## Draft review

- **Cursor preservation across live ↔ draft remount.** Scroll uses best-effort
  layout restoration, but selection/cursor restoration is still not deliberate.
- **Review ownership consolidation.** Review entry/exit, preview fetching,
  fallback routing, inline model sync, sidebar state, and discard commands are
  still spread across provider/hooks/components. Collapse them behind one deep
  controller when the interaction model settles.
- **Narrow viewport review parity.** The right rail intentionally hides below
  `lg`; make sure the docked diff panel keeps feature parity for any new
  Discard-class actions.

Design reference: [inline-diff-decoration-architecture.md].

[inline-diff-decoration-architecture.md]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/design/inline-diff-decoration-architecture.md

## Prove a block move leaves every other block's hash alone — [#111]

[#111]: https://github.com/haowjy/meridian-flow/issues/111

Dragging a figure into place ships: the registry marks a figure's body
`opaque`, so the picture itself is a drag handle, and every move goes through
`moveBlockToSeamTransaction` — a delete of the source followed by an insert at
the seam. ProseMirror's own HTML5 drag is refused wherever it would carry an
object, because it moves a node by serializing and re-parsing it.

What is still missing is the assertion that this is true: a test that moves a
figure and shows every OTHER block keeping its hash while the moved figure
gets a fresh Yjs item id. That contract is agent-edit's ("block hash = stable
block identity", `packages/agent-edit/.context/write-invariants.md`), and
y-prosemirror would break it silently by reconciling a reorder slot-wise.

Keep any schema-spec change mirrored between `apps/app/src/core/editor` and
`packages/prosemirror-schema`; the two schemas are built separately and parity
is currently unenforced.

## Task lists have a schema and a codec but no writer surface

`list_item.checked` is in the shared schema and `packages/markup` reads and
writes GFM `- [ ] ` / `- [x] ` items, so an AI write or a paste can put a task
list into a manuscript the writer then cannot author or toggle. TipTap's
TaskList/TaskItem are deliberately not registered: they add `taskList` and
`taskItem` node types the shared schema does not have. A writer surface means
an input rule and a keymap over the existing `list_item` + `checked`, plus a
checkbox in the list item's DOM, not the upstream nodes.

Found while pinning the markdown autoformat truth table
(`extensions/MarkdownAutoformatExtension.test.ts`); ruling 18 did not name it.
