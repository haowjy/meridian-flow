# surfaces/toolbar — contracts

The row keeps its controls in one order, so a control that can't apply greys with its reason instead of
disappearing as the caret travels. A pane too narrow for the row scrolls it. Inline code and strikethrough have
their surface in the formatting menu, and their commands live here so both share one fence.

`documentToolbarControls` maps editor state and host facts to one `{ active, blockedBy }` per control. Reasons are
codes; `toolbar-copy.ts` turns them into copy. Read-only outranks every contextual reason. `active` is computed even
while a control is greyed, so a read-only document still shows what the block already is.

## Two readings, owner first

`blockTypeRefusal` asks two questions in order.

1. **What is the selection standing inside?** `chromeContextRefusal(resolveChromeContext(state))`, the kernel's
   deepest-context read
   ([`core/editor/chrome`](../../../../../core/editor/chrome/.context/CONTEXT.md)). A caret in a diagram nested in a
   table cell is in the diagram, and the cell's reason would name the wrong thing.
2. **Only if the document owns the context, what does the selection span?** Every text block covered, each read through
   the same resolver. Any protected block refuses the whole conversion; the answer names a kind only when every block
   refuses as that kind, and is `mixed-selection` otherwise.

Reading the selection directly gives wrong reasons: prosemirror-tables spells "this table is selected" as a
`CellSelection`, which a local `instanceof NodeSelection` can't see.

A `code_block` owning an `object` context is a rendered diagram (the kernel names an object only what `isEditorObject`
accepts); one owning `source-block` is a plain fence.

The resolver is called rather than reading `chrome.context`: commands re-check this fence mid-chain, and a code-schema
document mounts no chrome. The resolver is pure over `EditorState`.

The span walk follows `selection.ranges`, not `from`..`to`: a `CellSelection` reports one of its cells as that pair while
ProseMirror's commands run over every range.

## Refusal predicates

- **Block type** rewrites whole blocks, so any protected target refuses. The code-block toggle and "turn into paragraph"
  are what a plain fence reverses, so `code-block` alone isn't a refusal for either. A mixed selection still is, because
  fencing the prose around a fence rewrites the fence's attributes. A rendered object fence isn't reversible at all:
  un-fencing a diagram is the same loss as converting one to a heading.
- **Marks** land per node, so they refuse only when nothing in the selection can take them. A table cell is prose: it
  refuses to become a heading and takes bold, which matters most for a selected table. Availability comes from
  `editor.can().setMark`, so the matrix can't advertise what dispatch refuses.

`turnIntoBlockType` is a true toggle: choosing the checked type returns the block to a paragraph.

Alignment has no fence: a select-all centers the chapter. A caret in a table cell aligns the table, because
`alignableBlocksInSelection` stops at the table; per-column alignment belongs to the grips.

Every other surface that rewrites a whole block calls `blockTypeRefusal` and `codeBlockRefusal`, so a new protected node
type is one edit here.

`blockedReasonMessage(subject, reason)` branches on the subject's family, not the control. `mixed-selection` and
`table-cell` only reach a block-type control.

## Closing a surface returns the caret

The alignment menu overrides Radix's `onCloseAutoFocus` and focuses the editor. Radix restores focus to the trigger, which
is wrong for a manuscript: the next Space has to be a space, not a control being re-activated.

## Why greying, not disabling

`disabled` removes the button from the hover and focus path, so its tooltip never opens and the writer never learns the
reason. Blocked controls carry `aria-disabled`, keep pointer events, and drop their `onClick`.
