# features/editor — app-facing editor surface

This directory owns the TipTap host and its writer-facing chrome: shared frame,
document toolbar, draft-review controls, synchronization status, and peer-mark
detail. Document schemas, session infrastructure, and ProseMirror extensions
belong under `core/editor`; project context owns pane and tab composition.

The interaction layer is being rebuilt against a design of record. Its trunk
is [`chrome/`](chrome/AGENTS.md): the primitives every surface renders from,
and the one host they all mount through. The persistent document toolbar is
[`surfaces/toolbar/`](surfaces/toolbar/AGENTS.md); the contextual bubbles were
deleted whole and their replacements are anchored to the blocks they serve.
Do not restore the old surfaces or grow new ones ad hoc here — build against
the design, from the primitives.

## Entry rules

- Keep prose geometry in `editor-column.ts`; hosts consume it rather than
  copying column or spacing classes. The toolbar row and the prose share one
  column edge, so a chrome row never re-encodes its own inset.
- Inline draft review mounts the server projection in an editable editor: the
  writer is a peer in the review branch room, and edits there land in that
  branch.
- Peer-mark evidence reads delegate to `features/change-trail`; this directory
  owns only the anchored popover and editor interaction.
- A new control surface is a directory under `surfaces/` plus one entry in
  `chrome/chrome-surfaces.ts`. `EditorView.tsx` mounts `EditorChromeHost` once
  and takes no further surfaces; a lane that edits it has taken a shared file
  hostage.
- Anything opened over the manuscript hands the caret back on close
  (`onCloseAutoFocus` → prose) and defers Escape to the kernel's chain. Both
  come free from the `chrome/` wrappers; a hand-rolled Radix root does not get
  them.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [`chrome/AGENTS.md`](chrome/AGENTS.md)
→ [`surfaces/toolbar/AGENTS.md`](surfaces/toolbar/AGENTS.md)
→ [`../../core/editor/AGENTS.md`](../../core/editor/AGENTS.md)
