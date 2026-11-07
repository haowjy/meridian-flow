# TODO — apps/www deferred work

- **Check the address-bar handling on a real iPhone** (`src/features/landing/film.css`,
  `scenery.css`, `film.ts`'s resize handler). The stage and the `--below` strip were
  checked only in Chromium with a faked strip, since Chromium can't collapse an address
  bar. Scroll the whole film in iOS Safari: the ground should reach the screen's bottom
  once the bar collapses, nothing the visitor reads should slide under the bar while it
  shows, and the page should not zoom out.
