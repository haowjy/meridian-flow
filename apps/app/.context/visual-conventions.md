# Visual conventions — app implementation

Design tokens, not sampled values in a design note, are the color authority. A
repeated cross-component rhythm gets an app utility in
[`globals.css`](../src/styles/globals.css); a value one component uses stays
local.

On shelf rows, the row hover uses `shelf-hover` and the quiet action button's
full accent uses `shelf-active`. Keep them distinct so an ellipsis stays a visible
target when its row is hovered.

Don't add fixed-rem overrides that pin code or table cells inside `prose-tokens`
off the text scale.

## Layout and overflow

- The shell uses `svh`, not `dvh`: `100dvh` tracks the mobile address bar as it
  animates. Revisit only for a measured layout bug (clipped shell, wrong scroll
  height).
- iOS input zoom is a separate problem: Safari zooms focused inputs below 16px.
  The fixes are 16px+ on focusable inputs and `text-size-adjust: 100%` on `html`,
  not `maximum-scale=1`, which blocks assistive zoom.
- `min-h-svh` on the shell root without `max-h` lets the shell grow with its
  content, which breaks scrollable regions. `h-svh` nested inside `app-frame`
  stacks viewport height; use `h-full min-h-0`.
- Each pane has one vertical scroll owner. Mobile keeps one `app-frame` with
  `TopBar` and `app-scroll`, with no document scroll fallback.
