# viewer-core — contracts

Reference depth for the pan/zoom module. Read [`AGENTS.md`](../AGENTS.md)
first.

## The seam

```ts
const viewer = createPanZoomViewer({
  host,          // clips; gesture listeners bind here
  content,       // the caller's wrapper, sized to the content's intrinsic box
  minScale: 0.1, // absolute; lowered to the fit scale when the content is huge
  maxScale: 8,
  padding: 24,   // clear space kept around a fitted view
  stepFactor: 1.6, // one double-click, one zoom button
});

viewer.scale;            // applied scale; 1 is the content's intrinsic size
viewer.pan;              // {x, y} in host px
viewer.fitted;           // true until a gesture moves the view off its fit
viewer.sizes();          // { host, content, fitScale, realZoom }
viewer.zoomBy(1.6, at?); // `at` host-relative; omitted means the host's center
viewer.zoomTo(2, at?);
viewer.panBy({ x, y });
viewer.fit();            // fit + center; also the mount state
viewer.resize();         // re-measure (the ResizeObserver calls it for you)
viewer.subscribe(listener); // → unsubscribe
viewer.destroy();
```

`sizes()` is the spike's `getSizes()` contract with honest names: `content` is
the untransformed layout box (svg-pan-zoom called this `viewBox` because it
had destroyed the attribute and needed the number back), `fitScale` is what
Fit would land on, `realZoom` is what is applied.

Sizing the content wrapper is the caller's job, and `intrinsicContentSize`
does the awkward part: mermaid emits `width="100%"` with the real dimensions
in the `viewBox`, so a wrapper left to itself collapses to zero.

## Invariants

- **A subscriber sees state that is already true.** Listeners fire during
  `commit`, before the frame that writes the DOM, so every getter is correct
  at that moment. `subscribe` is the only notification channel — an `onChange`
  option beside it would be a second way to learn the same thing.
- **`fitted` survives only until a gesture.** `resize()` refits a fitted view
  and leaves a moved one alone: a window resize or a source pane opening is
  not a request to lose your place. `fit()` restores the flag.
- **Limits float with the fit.** `minScale` is lowered to the fit scale when
  the content is bigger than that floor allows, so a wall-sized diagram is
  never refused its own fit by the rule meant to stop the writer zooming into
  nothing.
- **Right-click is not a gesture.** `contextmenu` releases pointer capture and
  drops the live pointers, so a menu opened mid-drag does not leave the viewer
  panning behind it.

## Rationale

**Own it rather than buy it.** `svg-pan-zoom@3.6.2` was spiked against five
criteria and failed pinch as shipped (two-finger spread panned the diagram
sideways; source reads `evt.touches[0]` only, beside a decade-old
`TODO: use hammer.js`). The documented remedy adds a second abandoned
dependency and glue whose own demo anchors 257 px off. Lifted instead: the
fit/contain/center math, the `getSizes()` information, rAF-throttled writes
with synchronous getters, and the element-relative at-point convention —
documented here rather than left undocumented as upstream did.

**`beforePan` / `beforeZoom` deliberately not lifted.** The spike named them
as a good hook shape, but their only real use here is clamping, and clamping
is implemented directly. Two mechanisms for one concern is the complexity the
hooks were supposed to prevent. Add them when a second use exists.

**Zoom is absolute, not relative to fit.** One number instead of two
(`zoom` × `realZoom`), so the percentage readout, the limits, and the math all
speak the same units. Fit is then a transform like any other rather than a
second origin.

**Mean distance from the centroid, not first-to-second distance,** measures
the pinch spread. A third finger landing mid-gesture shifts the scale smoothly
instead of redefining which two fingers count.

**Wheel factors are exponential.** `exp(-delta * k)` makes zooming out n
notches and back in n notches exact; a linear step drifts, and the drift reads
as a diagram that creeps every time the writer changes their mind.

## Pitfalls

- `getBoundingClientRect()` on the content reports the *transformed* box.
  Layout size is `offsetWidth`/`offsetHeight`.
- The `wheel` listener is registered non-passive because it calls
  `preventDefault`; without that the page behind a dialog scrolls under the
  diagram.
- `destroy()` really does restore the caller's DOM — the only property the
  viewer ever wrote is `transform` on a wrapper the caller owns.
