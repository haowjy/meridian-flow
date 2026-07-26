# features/editor — app-facing editor surface

This directory owns the TipTap host and its writer-facing chrome: shared frame
and toolbar, draft-review controls, synchronization status, and peer-mark
detail. Document schemas, session infrastructure, and ProseMirror extensions
belong under `core/editor`; project context owns pane and tab composition.

## Entry rules

- Keep prose geometry in `editor-column.ts`; hosts consume it rather than
  copying column or spacing classes.
- Inline draft review mounts the server projection read-only and omits writing
  controls.
- Peer-mark recovery delegates to `features/change-trail`; this directory owns
  only the anchored popover and editor interaction.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`../../core/editor/AGENTS.md`](../../core/editor/AGENTS.md)
