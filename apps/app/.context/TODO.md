# TODO — apps/app deferred work

## Draft review UX — undo & review rearchitecture

Design: [inline-diff-decoration-architecture.md] and [undo-draft-review-design.md]
in `meridian-flow-docs/work/human-undo-affordance/design/`.

- **Supporting doc reconciliation.** `undo-draft-review-design.md` still has stale
  live-doc-model references (geometry table, hunk contract, review entry). Align
  with the primary architecture doc or narrow to UX-only material.

[inline-diff-decoration-architecture.md]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/design/inline-diff-decoration-architecture.md
[undo-draft-review-design.md]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/design/undo-draft-review-design.md

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

- **Proper link entry UX.** ([#90](https://github.com/haowjy/meridian-flow/issues/90))
  The toolbar Link button hardcodes `href: "https://meridian.bio"` — there's no
  way to enter/edit/remove a link. Needs a popover/inline input over the stock
  TipTap Link mark. `EditorToolbar.tsx`.

- **Image support.** ([#91](https://github.com/haowjy/meridian-flow/issues/91))
  Image insert/upload/paste/render needs hardening, and the `image` node vs
  custom `figure` node relationship needs a decision. `meridian-extensions.ts`,
  `EditorView.tsx`, `FigureNodeView.tsx`.

- **Better tables — creation UI, table toolbar, robust markdown paste.**
  ([#92](https://github.com/haowjy/meridian-flow/issues/92))
  No table creation affordance and no contextual table toolbar (insert/delete
  row/column, header toggle, alignment). The markdown-table clipboard parser
  (`markdown-paste.ts`) has review-confirmed bugs: document corruption from an
  over-open slice on paste-into-prose / paste-into-cell, a too-loose detector
  that reinterprets non-table text, and it ignores the `plain` (Shift+Paste)
  flag. Clipboard policy also lives in the view shell instead of the editor
  config seam.

- **Unify rendered-markdown (Streamdown) styling with the editor.**
  ([#93](https://github.com/haowjy/meridian-flow/issues/93))
  The `.prose-tokens` Streamdown surface (chat answers, helper results) and the
  `.meridian-editor .ProseMirror` editor surface have drifted (code-block chrome
  + syntax colors, inline code, tables, blockquote). Streamdown's Shiki
  highlighting is currently inert. Read-only *documents* already match the editor
  (they reuse it). `Markdown.tsx`, `globals.css`, `editor.css`,
  `design-tokens/ink-jade.css`.
