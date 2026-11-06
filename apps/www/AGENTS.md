# @meridian/www

The public, unauthenticated marketing site.

`@meridian/design-tokens` is the only workspace package it imports. A route that
needs domain or runtime packages belongs in `@meridian/app`, as does anything
authenticated.

## Landing page

- React renders the markup once, so the page is server-rendered and stacks without
  script. `features/landing/film.ts` then owns that DOM frame by frame: typed text,
  `hidden`, positions. `LandingPage` holds no state, so React never re-renders what
  the film writes. State lives in the leaves (`TopBar`, `QuestionCard`) or in
  `card-store.ts`.
- Colour comes from token roles. Night regions set `data-ui-theme="dark"` on
  themselves; the product block and question card sit outside them, on the light
  root. Values no role covers go in `design-tokens/src/marketing.css`, or
  `marketing-sky.ts` for the shader.
- `ProductPlaceholder.tsx` is a drawing of the app, not the app: don't show anything
  there the real product doesn't do at that point in the story. Real footage replaces
  its markup and seeks in `createProductSlot`'s `set`.
- Nothing here links to the app's `/`: signed out, that redirects back to this page.
  Sign in goes to `/login`, Start writing to `/signup`. Recipe:
  [signed-out redirects](.context/qa/signed-out-redirects.md).
