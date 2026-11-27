import DOMPurify, { type Config } from "dompurify";

declare const sanitizedSvgBrand: unique symbol;
export type SanitizedSvg = string & { readonly [sanitizedSvgBrand]: true };

/**
 * A picture, and nothing that acts.
 *
 * The SVG profiles alone, which is the whole point: a diagram provider returns
 * a drawing, so scripts, event handlers, frames, form controls, and HTML
 * smuggled in through `<foreignObject>` all fall outside the allow-list rather
 * than needing to be named. `<foreignObject>` in particular is why the
 * renderer draws its labels as SVG text (`mermaid-render.ts`): the element
 * exists to carry arbitrary HTML into a picture, and it is also the one thing
 * a raster export never paints.
 *
 * Two attributes are added back because DOMPurify's SVG list omits them and
 * every rendered diagram uses them: the baseline a text label sits on, and the
 * `role` that tells a screen reader this is a graphic rather than a decoration.
 */
const SANITIZE_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_ATTR: ["dominant-baseline", "role"],
};

export function sanitizeSvg(markup: string): SanitizedSvg {
  return DOMPurify.sanitize(markup, SANITIZE_CONFIG) as SanitizedSvg;
}
