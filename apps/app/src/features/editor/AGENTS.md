# features/editor

The app side of the editor: `SessionEditor` binds a session and scope, `EditorView`
composes live or review presentation, and `chrome/` and `surfaces/` hold the
writer-facing controls. Schemas, Yjs sessions and ProseMirror extensions belong to
`core/editor`; pane and tab composition to `features/project/context`.

- Mount every control surface through `chrome/chrome-surfaces.tsx` and the single
  `EditorChromeHost` in `SessionEditor`. No ad-hoc portals or surfaces in `EditorView`,
  no selection bubbles, and contextual surfaces never become a second toolbar.
- Keep prose geometry in `editor-column.ts` and caret placement in
  `core/editor/landing`. Layout components don't answer presses or choose selection
  policy.
- `EditorScopeProvider` is the only app-to-editor scope seam; read
  `{ projectId, workId, rootThreadId }` with `useEditorScope`. Scope stays out of editor
  mount identity, or moving a holder destroys its editor and undo manager.
- The link and image runtimes render nothing. Visible outcomes are chrome surfaces; a
  runtime with its own Radix root is a surface the kernel can't subordinate.
- Clipboard access goes through [`clipboard.ts`](clipboard.ts), which owns capability,
  the rich/plain fallback and what a refusal means. Surfaces never call
  `navigator.clipboard`.
- `SessionEditor` is the one place that restores reading position for live Editor and
  dock mounts (`core/editor/use-reading-position.ts`). Review and paint-held mounts
  stand down and explicit destinations win; don't add a second timer or warm-tab path.
- Review is an editable peer on desktop and read-only on phone; the draft and its review
  base decide changes. See [draft review](../draft-review/AGENTS.md).

Review, scope and schema-repair edge cases:
[`.context/CONTEXT.md`](.context/CONTEXT.md). Deferred work:
[`.context/TODO.md`](.context/TODO.md).
