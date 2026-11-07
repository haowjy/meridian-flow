# @meridian/www

The public, unauthenticated marketing site.

`@meridian/design-tokens` is the only workspace package it imports. A route that
needs domain or runtime packages belongs in `@meridian/app`, as does anything
authenticated.

## Landing page

- React renders the markup, so the page is server-rendered and stacks without script.
  `features/landing/film.ts` then writes that DOM frame by frame: typed text, `hidden`,
  positions, labels. React only touches what its own render changes, so a component
  must never render a changing value into a node the film writes. A value the visitor
  changes goes through `card-store.ts`, which the card, the prose and the product block
  all read.
- CSS owns placement: `film.css` lays out the stage in container units, and
  `film-layout.ts` reads the result back. Don't compute geometry in script, or the first
  paint and the film disagree. Script only draws the SVG curves between what CSS placed.
- `timeline.ts` owns the beats and sections, `film-layout.ts` positions, `transport.ts`
  everything that moves the page for the visitor, and `film.ts` paints.
- Colour comes from token roles. Night regions set `data-ui-theme="dark"` on
  themselves; the product block and question card sit outside them, on the light
  root. Values no role covers go in `design-tokens/src/marketing.css`, or
  `marketing-sky.ts` for the shader.
- `ProductPlaceholder.tsx` is a drawing of the app, not the app. The page shows the
  [target][target], so helpers run at once here, and its phone tabs are simpler than the app’s drawer; everything else in the drawing must be
  something the real product does at that point in the story. Real footage replaces
  its markup and `product-placeholder.css`, and seeks in `createProductSlot`'s `set`.
- Nothing here links to the app's `/`: signed out, that redirects back to this page.
  Sign in goes to `/login`, Start writing to `/signup`. Recipe:
  [signed-out redirects](.context/qa/signed-out-redirects.md).

[target]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/public-site/landing-page-shows-the-target.md
