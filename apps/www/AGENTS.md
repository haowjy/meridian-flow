# @meridian/www

The public, unauthenticated marketing site. `@meridian/design-tokens` is the only
workspace package it imports. A route that needs domain or runtime packages, or
anything authenticated, belongs in `@meridian/app`.

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
  The scenery is the exception: each layer draws itself every frame from the beats.
- On a phone the stage is `100lvh`, as tall as the screen with Safari's address bar
  collapsed, and lays out in the `100svh` frame at its top. `--below` is the strip
  between them: the scenery runs into it, while text, the product and the card stay in
  the frame. Don't size the stage with `dvh`: Safari updates it only after a scroll ends,
  so the film jumps ([WebKit bug 266835](https://bugs.webkit.org/show_bug.cgi?id=266835)).
  Chromium can't collapse an address bar, so only a real iPhone shows this working.
- Anything that can run wider than a phone, such as a glow, sets `overflow-x: clip` on
  its own section. iOS Safari ignores that clip on `body` and zooms the whole page out
  to fit.
- `timeline.ts` owns the beats and sections. A pause or a longer moment is a row in
  `BEATS`, not a remapping of shares; split a beat whose parts need retiming on their
  own. A moment more than one scenery layer must agree on is a named cue there; where
  the ground, beach and shore are lives in `ground.ts`. Stacking order is the `--z-*`
  table on `.cine .stage` in `film.css`.
  [`film.html`](src/features/landing/.context/film.html) maps the beats, cues and
  layers; update its arrays when you retime the film.
- Colour comes from token roles. Night regions set `data-ui-theme="dark"` on
  themselves; the product block and question card sit outside them, on the light
  root. Values no role covers go in `design-tokens/src/marketing.css`, or
  `marketing-sky.ts` for the shader.
- The film tells a fictional LitRPG serial's Prologue. Read
  [`features/landing/.context/story.md`](src/features/landing/.context/story.md)
  (canon, intended impact, dropped ideas) before changing story copy in `story.ts`.
- `ProductPlaceholder.tsx` is a drawing of the app, not the app. The page shows the
  [target][target], so helpers run at once here and its phone tabs are simpler than the
  app's drawer; everything else in the drawing must be something the real product does
  at that point in the story. Real footage replaces its markup and
  `product-placeholder.css`, and seeks in `createProductSlot`'s `set`.
- Nothing here links to the app's `/`: signed out, that redirects back to this page.
  Sign in goes to `/login`, Start writing to `/signup`. Recipe:
  [signed-out redirects](.context/qa/signed-out-redirects.md).

[target]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/public-site.md#the-landing-page-shows-the-target
