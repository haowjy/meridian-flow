/**
 * The one door rendered markup takes to reach the page.
 *
 * A diagram is inserted as HTML, so "the provider returns safe markup" cannot
 * be a promise a provider makes in prose: the next diagram kind is one row in
 * the catalog plus a `render` that satisfies `Promise<string>`, and a string
 * carries no evidence of who checked it. `SanitizedSvg` is that evidence in the
 * type system — nominally distinct from `string`, produced only by
 * `sanitizeSvg` — so a consumer that inserts markup asks for a `SanitizedSvg`
 * and a provider's raw output will not compile in its place.
 *
 * Defense in depth, not the only defense. Mermaid escapes authored label text
 * itself under `securityLevel: "strict"`; this boundary is what holds for the
 * NEXT provider, and what a consumer can point at instead of naming today's
 * renderer.
 */

import DOMPurify, { type Config } from "dompurify";

/**
 * Markup that has been through `sanitizeSvg`.
 *
 * The brand is a phantom property: nothing is added at runtime — the value IS
 * the string — so it can be measured, exported, and handed to
 * `dangerouslySetInnerHTML` unchanged. What it cannot do is arrive from
 * anywhere else.
 */
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

/**
 * Sanitize rendered markup and mark it as such.
 *
 * Called once per settled render, at the render boundary every consumer already
 * shares (`diagram-render-state.ts`), so no provider and no face is the thing
 * standing between authored source and the page.
 */
export function sanitizeSvg(markup: string): SanitizedSvg {
  return DOMPurify.sanitize(markup, SANITIZE_CONFIG) as SanitizedSvg;
}
