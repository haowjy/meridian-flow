# diagrams — mermaid theming

Mermaid diagrams are themed by reading the **computed `rgb()` values** of the
application's design tokens at render time (`mermaid-theme.ts`). Do not pass
CSS custom properties or oklch strings to mermaid's theming API.

Meridian tokens are authored in oklch. Mermaid's color parser (khroma) cannot
parse oklch; it expects hex, named colors, rgb/rgba, or hsl/hsla. CSS custom
properties also fail because mermaid computes derived colors in JavaScript,
outside the browser CSS engine.

A measured token is the resolved `rgb()` string from `getComputedStyle` on a
mounted element whose styles reflect the current theme. Configuration is built
at render time, not import time. `useDiagramRender` redraws on the palette.

No stock mermaid colors (`#ECECFF`, `#9370DB`), no stock fonts (`trebuchet ms`),
and no literal hex values outside `packages/design-tokens`.

Rejected: oklch strings (khroma throws), authored hex equivalents (a parallel
color table), CSS custom properties (opaque strings, NaN derivatives).
