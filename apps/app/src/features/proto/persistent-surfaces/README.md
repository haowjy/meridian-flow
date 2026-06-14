# Persistent surfaces prototype

Disposable route at `/proto/persistent-surfaces` that de-risks lifting heavy
stateful surfaces (chat + documents) above the destination switch in a future
`ProjectView` refactor.

## What each mechanism proves

| Mechanism | Surface | What it proves |
|-----------|---------|----------------|
| **Session registry** | Both | Model/session state lives in a shell-level `Map`-backed provider; destinations are pure binders that never own lifecycle. |
| **Motion `layout`** | Chat | One mounted `motion.div` glides between dock (Home/Context) and center (Chat) without remounting. `layoutScroll` on the transcript keeps scroll stable during animation. |
| **`react-reverse-portal`** | Document | The same live DOM node (textarea + ticker + scroll) reparents between Context main viewer and Chat side-peek via `InPortal` / `OutPortal`. |

## Litmus test (proof-of-life)

Each surface shows a **ticker** (increments every 250ms), **scroll position** in a
long list, and (document only) **typed text + caret** in a textarea.

Toggle **Home → Chat → Context → Home**. If surfaces remounted, tickers reset to
0 and scroll/text are lost. If lifted correctly, all values continue unbroken.

## Pitfalls encountered / to watch

### Motion `layout`

- **Absolute positioning + `layout`**: chat uses `absolute` placement with
  different width/inset per destination. Motion animates well but the element
  must stay mounted at the shell level — never inside destination conditionals.
- **`layoutScroll` is required** on the scrollable transcript or scroll position
  jumps during the glide.
- **Reduced motion**: transitions set to `duration: 0` when
  `prefers-reduced-motion: reduce` — verify in OS accessibility settings.
- **Z-index**: lifted chat sits above remountable placeholders (`z-20`).

### `react-reverse-portal`

- **Only one `OutPortal` per node** at a time — switching Context ↔ Chat peek
  unmounts one slot before mounting the other. State survives because the
  `InPortal` content never unmounts.
- **Host slot sizing**: the portal host (`DocSlot`) must give `min-h-0 flex-1`
  or the reparented editor collapses.
- **No free animation**: reparent is instant; slot chrome could be wrapped in
  Motion separately if we need peek slide-in later.

### Registry vs DOM persistence

- Ticker intervals run in `SessionRegistryProvider` (lifted), not in destination
  views — makes registry ownership obvious even though the DOM persistence is
  the headline proof.
- Scroll restoration uses ref callbacks; a production version should use
  controlled scroll sync or `useLayoutEffect` to avoid flicker on fast swaps.

## Recommendation for production

| Surface | Harden |
|---------|--------|
| **Chat** | Motion `layout` (or explicit `animate` on geometry) — single instance, predictable box animation between dock and center. |
| **Documents** | `react-reverse-portal` (or equivalent reparent primitive) — editor DOM must survive Context ↔ peek without TipTap re-init. |

Registry pattern applies to both: lift session records to app shell; views bind
by id only.
