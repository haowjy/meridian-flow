# test-support

Shared fixtures for app tests. A fixture used by one suite belongs with that suite.

Use the smallest real tier:

- `standalone-editor.ts` is the default for one writer and node-position queries.
- `collab-editors.ts` is for peer writes or Yjs UndoManager behavior. y-prosemirror's
  rebuild isn't reproduced by hand-built transactions.
- Review-scope fixtures use real presented review, Chat and Work scopes with
  instance-owned network and account seams. Dispose them after render, and don't run
  them concurrently unless each owns its dependencies.
- Session and editor-shell fixtures need explicit disposal after unmount. Mounted
  editor panes use `EditorSurfaceFrame`, because measured chrome and clipping depend on
  its positioned, overflow boundary; a fake stable-layout marker isn't equivalent.
- Browser-only visibility, measured geometry and clipping belong in a real browser
  probe, not jsdom. There is no React-root test tier: project chrome is checked by
  [`docs/qa/project-chrome-manual.md`](../../../../docs/qa/project-chrome-manual.md).
- Harnesses that claim transport ordering use the real `DocumentSocketHarness`; the
  held fake stores local bytes before announcement and can't witness wire order.

Shuffle touched suites with multiple seeds. Reset module-level state through
instance-owned fixtures, keep waits clock-driven, and fix fixture warnings instead of
silencing them.
