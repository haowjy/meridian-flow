# Viewer contracts

The viewer exposes synchronous state over a caller-owned host and wrapper. The
wrapper must be intrinsically sized before fitting; the viewer only transforms
it.

`fitScale` is computed from host/content sizes and padding. `minScale` may be
lowered to permit fitting content larger than its configured floor; `maxScale`
remains an absolute ceiling. `fitted` survives resize while the view is still
fitted and becomes true again only after `fit()`.

Pinch scale uses the centroid and mean pointer distance, so adding a third
finger does not redefine the gesture pair. Wheel factors are exponential for
reversible in/out steps. Zoom anchors and pan coordinates are host-relative.

Subscribers run during commit before the next frame's style write. `resize()`
re-measures and refits only an unmodified view. `contextmenu` clears pointers
and capture. `lostpointercapture`, `pointerup`, and `pointercancel` all settle a
gesture. Non-passive wheel handling is required because the viewer prevents
page scrolling.

`destroy()` is idempotent, restores `transform`, `transformOrigin`, and
`willChange`, removes `data-panning`, releases captures, and makes API calls
inert so late effects cannot touch a reused element.
