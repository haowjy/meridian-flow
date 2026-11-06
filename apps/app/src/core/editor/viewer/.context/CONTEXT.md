# Viewer contracts

The wrapper has to be intrinsically sized before fitting. `fitted` survives resize
while the view is still fitted and becomes true again only after `fit()`; `resize()`
refits only an unmodified view.

Pinch uses the centroid and mean pointer distance, so adding a third finger doesn't
redefine the gesture pair. Wheel handling is non-passive because the viewer prevents
page scrolling. `destroy()` makes API calls inert so late effects can't touch a reused
element.

## Rejected: `svg-pan-zoom`

Its pinch is broken (it predates Pointer Events) and it strips `viewBox`. Its
`beforePan`/`beforeZoom` veto hooks have no use here that `minScale` and `maxScale`
don't cover.
