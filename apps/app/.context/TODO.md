# TODO — apps/app editor deferred work

Editor UX gaps found while dogfooding the v3 editor. Each item is tracked by a
GitHub issue; reopen/expand the issue when the work is picked up. Keep this list
in sync with the issues.

## Deferred — tracked

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
