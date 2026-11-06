# core/editor/viewer — disposable pan and zoom

Moves a caller-owned content wrapper inside a clipping host. It knows no TipTap,
React, SVG or diagram surface.

- Coordinates are host-relative: `clientX - host.getBoundingClientRect().left`.
- Callers read scale and intrinsic dimensions from `sizes()`, not transformed DOM
  rects.
- No pan-zoom library and no `beforePan`/`beforeZoom` veto hooks
  ([why](.context/CONTEXT.md)); `minScale` and `maxScale` cover the only real use.
- Drag prevents selection. A caller needing selectable content needs a different
  affordance, not a viewer flag.
