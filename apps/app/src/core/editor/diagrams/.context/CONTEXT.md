# Diagram rendering contracts

Diagram rendering is token-time and provider-keyed. A node view presents a
rendered face or source face from the same state; it does not own a second
provider lifecycle.

Mermaid measurement must use the SVG's intrinsic dimensions from its `viewBox`
when emitted width is `100%`; the caller sizes the wrapper before the viewer
fits it. Rendering must resolve design tokens at render time so a palette change
repaints existing markup. Out-of-order async results are ignored when the
provider or render request is no longer current.

Mermaid is themed from the computed `rgb()` values of the design tokens, read
at render time. Rejected: oklch strings (mermaid's color parser throws), authored
hex equivalents (a parallel color table), and CSS custom properties (opaque to
its JavaScript color derivation). No stock mermaid colors or fonts.

Errors remain writer-readable state and expose only the node view's supplied
action. Sanitization occurs before state publication and returns branded SVG;
providers and node views must not bypass that boundary.
