# core/editor/viewer — pan and zoom, owned

A headless pan/zoom module over two elements: a host that clips and a
transform host that moves. Nothing here knows about TipTap, ProseMirror,
React, or diagrams. The diagram lightbox is its first caller; an image viewer
would be its second without a change.

## Mental model

One gesture stream. `pointerdown` with one live pointer is a drag, with two it
is a pinch, and the code never asks which device it is serving — that single
`PointerEvent` path is why the module is short, and it is the thing
`svg-pan-zoom` cannot do (spike verdict, 2026-07-29: REJECTED, pinch broken,
input layer predates Pointer Events).

The transform is `translate(pan) scale(scale)` from the content's top-left, so
a content point `c` lands at `pan + c * scale`. `viewer-math.ts` is that one
equation solved for whichever end is known, pure and DOM-free;
`pan-zoom-viewer.ts` adds listeners and exactly one DOM write.

## Key rules

- **Transform-only, and never on the content itself.** The caller wraps what
  it is showing in its own element and the viewer moves that wrapper. A
  rendered SVG stays byte-exact, so copy, download, and re-measure downstream
  see what mermaid produced. (svg-pan-zoom stripped `viewBox` to do this job
  and never put it back.)
- **Points are host-relative.** `clientX - host.getBoundingClientRect().left`,
  always. Passing client coordinates puts the anchor `offset * (scale - 1)` px
  off — invisible at the page origin, guaranteed in a dialog.
- **Reads are synchronous, writes are not.** Getters answer from state; the
  `style.transform` write coalesces to one per frame. A caller never has to
  know a frame is pending, and must not read the DOM to learn the transform.
- **View state is disposable** (decision 2026-07-29). Nothing persists; a
  viewer that is destroyed and rebuilt opens fitted. There is no restore path
  to keep honest.
- **Drag pans, so drag does not select.** `pointerdown` prevents default,
  which costs text selection inside the content. Accepted deliberately for the
  diagram (its ⋮ copies the source); a caller that needs selectable content
  needs a different affordance, not a flag.

## Anti-patterns

- Reading `content.style.transform` to find the current scale. Call `sizes()`.
- Measuring the content with `getBoundingClientRect()` while it is
  transformed. `offsetWidth`/`offsetHeight` are layout values; the rect is not.
- Adding `beforePan`/`beforeZoom` veto hooks because svg-pan-zoom had them.
  `minScale`/`maxScale` cover the only real use; see `.context/CONTEXT.md`.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ caller: [`features/editor/surfaces/objects`](../../../features/editor/surfaces/objects/AGENTS.md)
→ design of record: `editor-toolbar-split/interaction-model.md` §5.2,
  `spike-svg-pan-zoom.md`
