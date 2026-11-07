# Diagram rendering contracts

Mermaid measurement uses the SVG's intrinsic dimensions from its `viewBox` when the
emitted width is `100%`; the caller sizes the wrapper before the viewer fits it.

Mermaid is themed from the computed `rgb()` values of the design tokens, read at
render time so a palette change repaints existing markup. Rejected: oklch strings
(mermaid's color parser throws), authored hex equivalents (a parallel color table),
and CSS custom properties (opaque to its JavaScript color derivation).
