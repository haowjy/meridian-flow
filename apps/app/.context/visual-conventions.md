# Visual conventions — app implementation

Design tokens, not sampled values in a design note, are the color authority. A
repeated cross-component rhythm gets an app utility in
[`globals.css`](../src/styles/globals.css); a value one component uses stays
local.

Every interactive state is an ink overlay over its surface: `bg-ink-fill` (5%) for
hover and static wells, `bg-ink-fill-strong` (10%) for current, selected, open and
pressed. A control that paints its own fill takes the same steps through the
`interactive` state layer. Anything that overlaps scrolled content (sticky headers,
the active tab chip, menus, floating pills) keeps an opaque surface and lays the
overlay on top. Overlays stack, so an ellipsis on a hovered row stays a visible target.

Headings, group labels, rows, hints, empty lines and fills come from `role` in
[`components/ui/roles.ts`](../src/components/ui/roles.ts). A call site adds layout,
never type or colour. Jade text is `text-jade-text`; `primary` is for fills and icons.

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
