# core/editor/viewer — disposable pan and zoom

This headless module moves a caller-owned content wrapper inside a clipping
host. It knows no TipTap, React, SVG, or diagram surface.

## Mental model

One Pointer Events stream handles drag and pinch. The transform is
`translate(pan) scale(scale)` from the content's top-left, with pan in
host-relative pixels. `viewer-math.ts` is pure math; `pan-zoom-viewer.ts` owns
listeners and the coalesced DOM write.

## Rules

- Transform the caller's wrapper, never the rendered SVG/content itself.
- `clientX - host.getBoundingClientRect().left` is the coordinate convention;
  callers must not pass page or viewport coordinates.
- Getters and subscribers observe committed state synchronously. Style writes
  coalesce to one animation frame. Callers use `sizes()`, not transformed DOM
  rects, to read scale or intrinsic dimensions.
- State is disposable: destroy restores every borrowed style, releases pointer
  capture, clears panning, and makes later calls inert. No view state persists.
- Own it, do not buy it: `svg-pan-zoom` was spiked (2026-07-29) and rejected
  because pinch is broken (it predates Pointer Events) and it strips `viewBox`.
  Do not add `beforePan`/`beforeZoom` veto hooks; `minScale`/`maxScale` cover the
  only real use. Zoom is one absolute number, and wheel steps are exponential so
  n notches out and back is exact.
- Drag intentionally prevents selection. A caller needing selectable content
  needs a different affordance, not a viewer flag.

→ [`.context/CONTEXT.md`](.context/CONTEXT.md) — fit, pinch, and cleanup seams
→ caller: [`../../../features/editor/surfaces/objects/AGENTS.md`](../../../features/editor/surfaces/objects/AGENTS.md)
