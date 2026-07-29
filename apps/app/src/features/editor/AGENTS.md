# features/editor — app-facing editor surface

This directory owns the TipTap host and its writer-facing chrome: shared frame,
document toolbar, draft-review controls, synchronization status, and peer-mark
detail. Document schemas, session infrastructure, and ProseMirror extensions
belong under `core/editor`; project context owns pane and tab composition.

The interaction layer is being rebuilt against a design of record. The
document toolbar is the first module of that rebuild and lives in
[`surfaces/toolbar/`](surfaces/toolbar/AGENTS.md); the contextual bubbles were
deleted whole and their replacements are anchored to the blocks they serve.
Do not restore the old surfaces or grow new ones ad hoc here — build against
the design.

## Entry rules

- Keep prose geometry in `editor-column.ts`; hosts consume it rather than
  copying column or spacing classes. The toolbar row and the prose share one
  column edge, so a chrome row never re-encodes its own inset.
- Inline draft review mounts the server projection in an editable editor: the
  writer is a peer in the review branch room, and edits there land in that
  branch.
- Peer-mark evidence reads delegate to `features/change-trail`; this directory
  owns only the anchored popover and editor interaction.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`surfaces/toolbar/AGENTS.md`](surfaces/toolbar/AGENTS.md)
→ [`../../core/editor/AGENTS.md`](../../core/editor/AGENTS.md)
