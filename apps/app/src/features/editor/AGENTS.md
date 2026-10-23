# features/editor — app-facing editor surface

This directory adapts the shared editor to project documents: `SessionEditor`
binds a session and scope, `EditorView` composes live or review presentation,
and `chrome/` hosts writer-facing controls. Schemas, Yjs session machinery,
and ProseMirror extensions belong to `core/editor`; pane and tab composition
belongs to `features/project/context`.

Contextual surfaces are built from the `chrome/` primitives, with the
persistent document toolbar owning the command layer they share. There are no
selection bubbles and no ad-hoc surfaces.

## Rules

- Mount every control surface through `chrome/chrome-surfaces.tsx` and the
  single `EditorChromeHost` in `SessionEditor`; do not add ad-hoc portals or
  surfaces to `EditorView`.
- Keep prose geometry in `editor-column.ts` and caret placement in
  `core/editor/pointer-boundary`. Layout components guard presses; they do not
  choose selection policy.
- `EditorScopeProvider` is the sole app-to-editor scope seam. Consumers read
  `{ projectId, workId, rootThreadId }` with `useEditorScope`; scope is runtime
  context and is not part of editor mount identity.
- Link and image concerns mount one null-rendering runtime each. Visible
  outcomes are chrome surfaces, so runtimes must not render their own Radix
  roots.
- Clipboard access goes through [`clipboard.ts`](clipboard.ts), which owns
  capability, the rich/plain fallback and what a refusal means. Surfaces choose
  a payload and destination; they do not call `navigator.clipboard` directly.
- Desktop review is an editable peer in the review room; phone review is
  read-only. The mounted draft and its review base decide changes; attribution
  supplies bylines. See [draft review](../draft-review/AGENTS.md).
- `SessionEditor` owns device reading memory for live Editor and dock mounts
  (`core/editor/use-reading-position.ts`). Review and paint-held mounts stand
  down, and explicit destinations win. Reading position is restored in that one
  place, never by a second timer or warm-tab path.
- Chrome wrappers own focus return and Escape. A surface opened over prose
  must return focus through the wrapper and must not install a private handler.

## Child guides

- [`chrome/AGENTS.md`](chrome/AGENTS.md)
- [`surfaces/blocks/AGENTS.md`](surfaces/blocks/AGENTS.md)
- [`surfaces/formatting/AGENTS.md`](surfaces/formatting/AGENTS.md)
- [`surfaces/images/AGENTS.md`](surfaces/images/AGENTS.md)
- [`surfaces/link/AGENTS.md`](surfaces/link/AGENTS.md)
- [`surfaces/objects/AGENTS.md`](surfaces/objects/AGENTS.md)
- [`surfaces/peer-marks/AGENTS.md`](surfaces/peer-marks/AGENTS.md)
- [`surfaces/slash/AGENTS.md`](surfaces/slash/AGENTS.md)
- [`surfaces/table/AGENTS.md`](surfaces/table/AGENTS.md)
- [`surfaces/toolbar/AGENTS.md`](surfaces/toolbar/AGENTS.md)

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) for review/session edge
cases and the editor-to-project boundary.
Deferred editor work is tracked in [`.context/TODO.md`](.context/TODO.md).
