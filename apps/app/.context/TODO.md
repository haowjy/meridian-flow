# TODO — apps/app deferred work

## Editor UX gaps — deferred, tracked

- **Temp-doc save row: persistent band vs save-time affordance.**
  ([#209](https://github.com/haowjy/meridian-flow/issues/209))
  PR #208 collapsed the form to one VS Code-style URI line, but the line is
  still a *persistent* band above the toolbar. Remaining candidates:
  save-from-tab (row appears only at save time), inline title-first.
  Presentation-only — the save state machine (`use-temp-document-save.ts`)
  stays as is. `TempDocumentSaveBar.tsx`.

- **Block-level `+` gutter handle.**
  ([#210](https://github.com/haowjy/meridian-flow/issues/210))
  "Turn into" / "Insert" menu on the current paragraph. Additive to the docked
  formatting toolbar, never a replacement; a real build parked for its own
  slice. `features/editor/`.

- **Fade-on-scroll for the docked toolbar.**
  ([#211](https://github.com/haowjy/meridian-flow/issues/211))
  Fade/slide the toolbar row away while writing or scrolling, back on
  selection/focus. New interaction behavior — placement settled first
  (tab-direction E). `EditorSurfaceFrame.tsx`.

- **`image` versus `figure`.** ([#91](https://github.com/haowjy/meridian-flow/issues/91))
  Ingress (insert, upload, paste, import, pending lifecycle) lives in
  `core/editor/images/`. What remains undecided is the relationship between the
  inline `image` node and the captioned block `figure` node, whose node view
  still carries its own editing form. `FigureNodeView.tsx`,
  `meridian-extensions.ts`.

- **Unify rendered-markdown (Streamdown) styling with the editor.**
  ([#93](https://github.com/haowjy/meridian-flow/issues/93))
  The `.prose-tokens` Streamdown surface (chat answers, helper results) and the
  `.meridian-editor .ProseMirror` editor surface have drifted (code-block chrome
  + syntax colors, inline code, tables, blockquote). Streamdown's Shiki
  highlighting is currently inert. Read-only *documents* already match the editor
  (they reuse it). `Markdown.tsx`, `globals.css`, `editor.css`,
  `design-tokens/ink-jade.css`.
