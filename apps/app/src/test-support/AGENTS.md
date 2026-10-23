# test-support

Shared fixtures for app tests. Production behavior does not belong here, and a
fixture used by one suite belongs with that suite.

## Choose the smallest real tier

- `standalone-editor.ts` is the default for one writer and node-position
  queries.
- `collab-editors.ts` is only for peer writes or Yjs UndoManager behavior.
  y-prosemirror's rebuild is not reproduced by hand-built transactions.
- Review-scope fixtures use real presented review, Chat, and Work scopes with
  instance-owned network/account seams. Dispose them after render; do not run
  them concurrently unless each owns its dependencies.
- Session/editor-shell fixtures require explicit disposal after unmount.
  Mounted editor panes use `EditorSurfaceFrame`, because measured chrome and
  clipping depend on its positioned, overflow boundary. A fake stable-layout
  marker is not an equivalent fixture.
- Browser-only visibility, measured geometry, and clipping belong in a real
  browser probe, not jsdom. There is no React-root test tier: project chrome is
  checked by the manual recipe in
  [`docs/qa/project-chrome-manual.md`](../../../../docs/qa/project-chrome-manual.md).
  A claim that needs a React root is usually about what the writer sees, which a
  browser judges and jsdom cannot.
- Harnesses that claim transport ordering must use the real socket harness;
  the held fake stores local bytes before announcement and cannot witness wire
  order.

Shuffle touched suites with multiple seeds. Reset module-level state through
instance-owned fixtures, keep waits clock-driven, and fix fixture warnings
instead of silencing them.
