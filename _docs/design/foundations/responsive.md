# Responsive Design

The responsive system defines how Meridian adapts across device classes.
Mobile is not a compressed desktop — each tier has a deliberate form
designed for its input method, screen geometry, and usage posture.

---

## Design Intent

Meridian is a **responsive-first** product. Desktop and mobile are co-equal
design targets. The three-mode architecture (Agents, Converse, Studio)
translates to every tier, but the shell shape, navigation surface, and pane
model change to match the device.

> **Decision:** Mobile is co-equal with desktop. Every mode, interaction, and
> component must have a deliberate mobile form — not a graceful degradation of
> the desktop layout.
>
> **Rationale:** Fiction writers use phones and tablets for reading, reviewing,
> light editing, and chat-first workflows. A desktop-only product loses the
> writer during commutes, reading sessions, and quick review passes. The
> strongest exemplars (Notion, Linear, Obsidian, Ulysses, Bear) treat mobile
> as a distinct product form, not a viewport shrink.
>
> **Rejected:** "Desktop-first with graceful degradation" — produces a
> compressed desktop that is usable but not good. "Mobile-first" — the
> product's primary editing surface (CM6 multi-pane) is genuinely
> desktop-optimized; mobile-first would underserve the core use case.
>
> *Evidence: mobile-responsive-shell.md §Recommended default design policy;
> mobile-touch-editing.md §Executive summary.*

---

## Tier System

Three tiers, each with a distinct shell shape. The tiers replace the
earlier Expanded/Medium/Compact naming — those names now map to these tiers
for backwards compatibility.

| Tier | Viewport width | Shell shape | Nav surface | Pane model | Input |
|---|---|---|---|---|---|
| **Phone** | < 600px | Single pane + bottom nav | BottomNav (3 tabs + overflow) | Full-screen swap, drawers, bottom sheets | Touch-primary, no hover |
| **Tablet** | 600–1199px | Reduced multi-pane | BottomNav or Rail (see below) | Primary + toggle overlay, split when space allows | Touch + optional keyboard |
| **Desktop** | ≥ 1200px | Full multi-pane | Rail (48px left) | Resizable panes via `react-resizable-panels` | Pointer + keyboard |

> **Decision:** Three tiers with Tablet as a distinct tier (not a big phone).
> Phone < 600px, Tablet 600–1199px, Desktop ≥ 1200px.
>
> **Rationale:** The research shows that tablet should restore reduced
> multi-pane behavior (Ulysses, Obsidian, Bear all treat iPad distinctly).
> A writing tool benefits significantly from showing list + detail or
> editor + chat side-by-side on a 10" screen. Collapsing tablet to single-
> pane wastes the available space.
>
> **Rejected:** Two-tier (phone + desktop) — wastes tablet real estate.
> Four-tier (adding a "large phone" tier at 600–899px) — added complexity
> without meaningful behavioral difference for this product.
>
> *Evidence: mobile-responsive-shell.md §2 Breakpoint strategy; the
> exemplar matrix showing Ulysses, Obsidian, and Bear all have distinct
> tablet treatments.*

### Backwards Compatibility

| Old name | New tier |
|---|---|
| Expanded (≥ 1200px) | Desktop |
| Medium (840–1199px) | Tablet (upper range) |
| Compact (≤ 839px) | Tablet (600–839px) + Phone (< 600px) |

The old Medium tier splits: its upper portion (840–1199px) is now part of
Tablet; its lower portion (600–839px) was previously Compact and is now also
Tablet. The behavioral difference between 600px and 1100px Tablet is handled
by the per-mode layout specs, not by a tier boundary.

### Tier Detection

Tiers are detected via CSS viewport media queries on the **outermost shell
container**. Component internals that need to adapt to available space use
**container queries** instead.

```css
/* Shell-level tier detection */
@media (max-width: 599px)  { /* Phone */ }
@media (min-width: 600px) and (max-width: 1199px) { /* Tablet */ }
@media (min-width: 1200px) { /* Desktop */ }
```

> **Decision:** Viewport breakpoints for shell-level changes (nav surface,
> pane count, shell shape). Container queries for pane internals (component
> density, text truncation, column count).
>
> **Rationale:** The shell mode depends on the device viewport — a bottom
> nav on a phone regardless of how wide the current pane is. But a component
> inside a resizable pane should adapt to its own available width, not the
> viewport — a chat pane at 400px on a desktop should render the same as a
> chat pane at 400px on a tablet.
>
> *Evidence: mobile-responsive-shell.md §2 Breakpoint strategy ("put shell
> mode changes in viewport breakpoints, put pane internals in container
> queries"); MDN container queries documentation.*

---

## Tablet Navigation: Rail vs BottomNav

> **Decision:** Tablet uses the **BottomNav** in portrait orientation and
> the **Rail** in landscape orientation (when width ≥ 900px).
>
> **Rationale:** In tablet portrait (~600–800px width), horizontal space is
> scarce — the 48px rail consumes a proportionally large amount. BottomNav
> preserves horizontal width for content. In tablet landscape (typically
> ≥ 900px), there is enough horizontal space for the rail, and the rail
> provides a more desktop-like multi-pane experience that matches the
> restored split-pane layouts available at wider tablet widths.
>
> **Rejected:** Always Rail on tablet — wastes horizontal space in portrait.
> Always BottomNav on tablet — forfeits the desktop-like posture in landscape
> where multi-pane layouts are available.
>
> *Evidence: mobile-responsive-shell.md §1 showing exemplars collapse
> sidebars in portrait iPad (Bear, Obsidian) but restore them in landscape.*

Detection uses a combined query:

```css
/* Tablet portrait: BottomNav */
@media (min-width: 600px) and (max-width: 899px) { /* BottomNav */ }

/* Tablet landscape / wide tablet: Rail */
@media (min-width: 900px) and (max-width: 1199px) { /* Rail */ }
```

---

## Viewport & Safe Area Tokens

### Dynamic Viewport Units

The app shell uses dynamic viewport units for full-height surfaces on mobile,
where browser chrome (URL bar, toolbar) changes height during scroll.

| Unit | Use | Fallback |
|---|---|---|
| `100dvh` | Editor shell, full-height surfaces | `100vh` on browsers without dvh support |
| `100svh` | Safe minimum height (e.g., dialogs) | `100vh` |

> **Decision:** Use `100dvh` as the primary full-height unit for the mobile
> shell. Accept the minor scroll jitter tradeoff.
>
> **Rationale:** `100dvh` tracks the dynamic visible area as browser chrome
> expands and collapses, preventing content from being hidden behind the URL
> bar. MDN warns of potential resize during scroll, but for a writing tool
> with fixed chrome (bottom nav, accessory bar) and inner scroll regions,
> the dynamic tracking is more important than avoiding micro-resizes.
>
> **Rejected:** `100vh` on mobile — causes content to extend behind the
> browser UI, hiding controls. `100lvh` — same problem in the opposite
> direction (leaves a gap when browser chrome is collapsed).
>
> *Evidence: mobile-responsive-shell.md §5; MDN length units documentation
> on dvh/svh/lvh behavior.*

### Edge-to-Edge Layout

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

`viewport-fit=cover` extends the layout into device safe areas (notch,
home indicator, rounded corners). Content in those areas must be padded
with safe-area insets.

### Safe Area Insets

All fixed chrome (BottomNav, AccessoryBar, status indicators) must include
safe-area padding:

| Edge | CSS | Applied to |
|---|---|---|
| Top | `env(safe-area-inset-top)` | Top-fixed headers when present |
| Bottom | `env(safe-area-inset-bottom)` | BottomNav, AccessoryBar, Composer |
| Left | `env(safe-area-inset-left)` | Full-width content in landscape |
| Right | `env(safe-area-inset-right)` | Full-width content in landscape |

Pattern:

```css
.bottom-nav {
  padding-bottom: calc(var(--bottom-nav-padding) + env(safe-area-inset-bottom));
}
```

### VisualViewport API

Used for positioning the AccessoryBar and keeping the caret visible when
the virtual keyboard is open.

| API | Use |
|---|---|
| `visualViewport.height` | Available height above the keyboard |
| `visualViewport.offsetTop` | Viewport scroll offset (for pinch-zoom) |
| `resize` event | Reposition AccessoryBar when keyboard appears/disappears |
| `scroll` event | Adjust for Safari viewport scroll |

On Chromium, `navigator.virtualKeyboard` and `env(keyboard-inset-height)`
are preferred when available (more accurate geometry, less JS). The
AccessoryBar implementation should feature-detect and prefer the
VirtualKeyboard API, falling back to VisualViewport.

---

## Touch Targets

The existing `--touch-target-min: 44px` token applies to all tiers. On
Phone and Tablet, this is enforced strictly — no interactive element may
have a hit area smaller than 44×44px. On Desktop, the same rule applies
via invisible hit-padding (as documented in `components.md`).

Android's recommendation is 48×48dp. The 44px minimum meets iOS guidelines
and is close enough to Android's 48dp (which is 48px at 1x density) that
the difference is within the padding budget. Components that need extra
touch safety on Android (e.g., the AccessoryBar actions) should use 48px
hit areas.

---

## State Preservation on Mobile

Mobile navigation (bottom-nav taps, drawer open/close, push navigation)
must preserve the same state guarantees as desktop mode switching:

| State | Preserved | Mechanism |
|---|---|---|
| Thread scroll position | Yes | Per-thread, in memory |
| Editor cursor + scroll | Yes | Per-document via DocSession |
| Composer drafts | Yes | Per-thread, in memory |
| Open tabs (Studio) | Yes | localStorage |
| Expanded tool groups | Yes | Per-thread, in memory |
| Drawer/sheet open state | No | Transient — resets on mode switch |
| BottomNav active tab | Yes | URL-driven (same as Rail) |

The mounted-shell strategy (all three mode shells mounted, inactive ones
`display:none` + `aria-hidden` + `inert`) applies identically on mobile.
The Active/Inactive Work Contract (pause non-essential work while hidden)
also applies. Mobile does not introduce a different mounting strategy.

> **Decision:** The mounted-shell + pause-non-essential-work contracts
> apply unchanged on mobile. No mobile-specific mounting or lifecycle
> differences.
>
> **Rationale:** The purpose of mounting all shells is instant, stateful
> mode switching. This is even more valuable on mobile, where the writer
> frequently taps between modes. Memory pressure on mobile devices is real,
> but the pause-non-essential-work contract already minimizes the hidden-
> shell cost. If memory becomes a problem in practice, the mitigation is
> more aggressive pausing, not a different mounting strategy.
>
> **Rejected:** Unmount inactive shells on mobile to save memory — loses
> the stateful-switch guarantee that the whole strategy exists to provide.

---

## Responsive Design Rules (Summary)

1. **Viewport queries for shell shape; container queries for pane internals.**
2. **Phone = single pane + bottom nav.** Every surface gets the full screen.
   Secondary content is a drawer or bottom sheet.
3. **Tablet = reduced multi-pane.** Primary + one secondary when space allows.
   BottomNav in portrait, Rail in landscape (≥ 900px).
4. **Desktop = full multi-pane.** Rail, resizable panes, hover affordances.
5. **Touch targets: 44px minimum on all tiers.** No exceptions on Phone/Tablet.
6. **Safe-area insets on all fixed chrome.** BottomNav, AccessoryBar, Composer.
7. **`100dvh` for full-height mobile surfaces.** Fallback to `100vh`.
8. **No hover-only affordances on Phone/Tablet.** Everything reachable by
   touch must have an explicit, visible control (not hover-revealed).
9. **State survives navigation.** The mounted-shell strategy and pause
   contract apply identically.
10. **Focus writing is the phone default.** Chrome minimized during typing.
    See `interaction/editor.md` §Touch & Mobile Editing.
