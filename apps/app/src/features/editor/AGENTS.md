# features/editor — app-facing editor surface

This directory owns the TipTap host and its writer-facing chrome: shared frame,
draft-review controls, synchronization status, and peer-mark detail. Document
schemas, session infrastructure, and ProseMirror extensions belong under
`core/editor`; project context owns pane and tab composition.

The manuscript is currently chromeless. The formatting toolbar and the
contextual bubbles were deleted whole; a ground-up redesign of that interaction
layer is approved and rebuilds them. Do not restore the old surfaces or grow
new ones ad hoc here — build against the design.

## Entry rules

- Keep prose geometry in `editor-column.ts`; hosts consume it rather than
  copying column or spacing classes.
- Inline draft review mounts the server projection in an editable editor: the
  writer is a peer in the review branch room, and edits there land in that
  branch.
- Peer-mark evidence reads delegate to `features/change-trail`; this directory
  owns only the anchored popover and editor interaction.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../../core/editor/AGENTS.md`](../../core/editor/AGENTS.md)
