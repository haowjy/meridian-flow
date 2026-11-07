# FUTURE — the landing film

- **Let idle frames lower the sky's resolution** (`film.ts`, the `slowFrames` check).
  Only painted frames are timed, so a device that struggles with `sky.breathe()` while
  the visitor sits still never steps the resolution down.
- **Skip the burn wall's shader work for the fight's breath** (`fight.ts`'s `NO_WALL`,
  `fire.ts`'s shader). The breath passes `char: NO_WALL`, but the shader still computes
  the wall, rim, veins and flare per pixel and throws them away. A branch on the
  sentinel, or a separate program for the breath, would skip it.
- **Show the night still in the address-bar strip during the burn** (`fire.ts`, `.flame`
  in `scenery.css`). The fire canvas stops above `--below`, so on a phone with the bar
  collapsed the strip shows the live scene under the fire instead of the night being
  burnt away.
