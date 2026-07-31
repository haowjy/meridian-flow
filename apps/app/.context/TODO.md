# TODO — apps/app deferred work

## Editor UX gaps — deferred, tracked

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

- **`image` versus `figure`: two nodes, one concept.**
  ([#91](https://github.com/haowjy/meridian-flow/issues/91))
  Settled: the verbs are one surface. Alt text, Replace, and the figure's caption
  and label are all `features/editor/surfaces/objects`, both node views are
  presentation, and the registration's `surfaceFields` is what differs.
  Still open, and schema-shaped: whether `figure` should exist at all, or a
  caption and label should be attributes of `image` in a block context. Also
  open, from §5.6: `figure`'s `src` is a passthrough that does not run the asset
  resolver, so it neither resolves `asset:` refs nor enforces the signed-URL
  exclusion the inline image does. `core/editor/FigureNodeView.tsx`,
  `packages/prosemirror-schema`.

- **Unify rendered-markdown (Streamdown) styling with the editor.**
  ([#93](https://github.com/haowjy/meridian-flow/issues/93))
  The `.prose-tokens` Streamdown surface (chat answers, helper results) and the
  `.meridian-editor .ProseMirror` editor surface have drifted (code-block chrome
  + syntax colors, inline code, tables, blockquote). Streamdown's Shiki
  highlighting is currently inert. Read-only *documents* already match the editor
  (they reuse it). `Markdown.tsx`, `globals.css`, `editor.css`,
  `design-tokens/ink-jade.css`.
