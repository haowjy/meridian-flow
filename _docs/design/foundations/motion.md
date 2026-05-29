# Motion

Motion is punctuation, not decoration. It orients, confirms, and disappears.
A calm writing interface uses motion to explain state changes, not to
entertain.

---

## Principles

1. **Motion explains transitions, not states.** Animate the change between
   states (panel opening, element appearing). Don't animate the resting state
   (no ambient pulsing, no perpetual shimmer, no parallax).

2. **Frequency inversely proportional to duration.** Interactions that happen
   many times per minute (hover, focus) get short durations. Interactions that
   happen once per task (dialog open, mode switch) can be slightly longer.

3. **Mode switching is instant.** Switching between Agents, Converse, and
   Studio is a CSS visibility toggle with no transition. The writer should
   never wait for a mode animation to complete.

4. **Respect `prefers-reduced-motion`.** When the user has enabled reduced
   motion, collapse all transitions to instant. Use `@media
   (prefers-reduced-motion: reduce)` to override all `transition` and
   `animation` properties.

*Evidence: Apple's HIG mandates purposeful, brief motion and explicit
reduced-motion support. Calm Technology principles prioritize peripheral
information delivery over attention-demanding animation
(design-language-best-practices §4, interaction-best-practices §5).*

---

## Duration Tokens

| Token | Value | Use |
|---|---|---|
| `--duration-instant` | `0ms` | Mode switch, panel resize (real-time) |
| `--duration-fast` | `100ms` | Syntax-marker hide in live preview, tooltip exit |
| `--duration-normal` | `150ms` | Hover states, micro-interactions, focus ring |
| `--duration-moderate` | `200ms` | Collapse/expand, toast enter, theme toggle, dialog backdrop |
| `--duration-slow` | `300ms` | Dialog/sheet enter, complex overlay transitions |

**Why these values:**
- 100–150ms is the threshold below which transitions feel "instant" to users
  but still provide visual continuity.
- 200ms is the standard for collapse/expand — long enough to read the motion,
  short enough to not impede.
- 300ms is the ceiling for UI transitions in a calm interface. Nothing should
  take longer.

## Easing Tokens

| Token | Value | Use |
|---|---|---|
| `--ease-default` | `cubic-bezier(0.2, 0, 0, 1)` | General-purpose, slightly decelerating |
| `--ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | Elements exiting: collapse, fade out |
| `--ease-in` | `cubic-bezier(0.8, 0, 1, 1)` | Elements entering (rare — most entries use ease-default) |
| `--ease-linear` | `linear` | Progress bars, continuous indicators |

---

## Motion Catalog

### Always Instant (0ms)

| Interaction | Why |
|---|---|
| Mode switch (Agents ↔ Converse ↔ Studio) | The writer expects immediate workspace change. Animation here adds latency. |
| Panel resize (drag) | Real-time feedback during drag. Any transition creates rubber-banding. |
| Typing in editor | No transition on text insertion/deletion. |
| Scroll | Native scroll behavior, no custom easing. |

### Fast (100ms)

| Interaction | Property | Easing |
|---|---|---|
| Live-preview syntax hide (e.g., `#` disappearing) | `opacity` | `ease-default` |
| Tooltip exit | `opacity` | `ease-out` |
| Live-preview syntax reveal | `opacity` | `ease-default` (80ms — slightly faster than hide for responsiveness) |

### Normal (150ms)

| Interaction | Property | Easing |
|---|---|---|
| Hover bg change (buttons, list items, tree items) | `background-color` | `ease-default` |
| Focus ring appear/disappear | `box-shadow` or `outline` | `ease-default` |
| Icon weight change (regular → bold on active) | `font-weight` | `ease-default` |
| Badge state change | `background-color`, `color` | `ease-default` |
| Resize handle teal tint on hover | `background-color` | `ease-default` |

### Moderate (200ms)

| Interaction | Property | Easing |
|---|---|---|
| Panel collapse/expand | `width` or `height` | `ease-out` |
| Accordion open/close | `height`, `opacity` | `ease-out` |
| Toast notification enter | `transform` (translateY), `opacity` | `ease-default` |
| Toast notification exit | `opacity` | `ease-out` |
| Theme toggle (light ↔ dark) | `background-color`, `color`, `border-color` | `ease-default` |
| Collapsible content reveal | `height`, `opacity` | `ease-out` |
| Tool group expand/collapse | `height`, `opacity` | `ease-out` |

### Slow (300ms)

| Interaction | Property | Easing |
|---|---|---|
| Dialog/sheet enter | `opacity`, `transform` (scale from 0.95) | `ease-default` |
| Dialog/sheet exit | `opacity`, `transform` | `ease-out` |
| Command palette appear | `opacity`, `transform` (translateY) | `ease-default` |
| Sheet slide in | `transform` (translateX) | `ease-default` |

---

## Reduced Motion

When `prefers-reduced-motion: reduce` is active:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

This collapses all motion to effectively instant while preserving the final
state of any animation. Elements still reach their target state — they just
arrive immediately.

**Exceptions:** Loading skeletons use `animation-delay` to stagger shimmer.
In reduced-motion mode, the skeleton renders as a static muted rectangle
(no shimmer), which is acceptable.

---

## What Is NOT Animated

The following elements are explicitly **not animated** and must remain static:

- **Editor text** — no text insertion/deletion animation
- **Scroll position** — native smooth scroll only (via `scroll-behavior:
  smooth` on scroll containers, which respects `prefers-reduced-motion`)
- **Mode switching** — instant CSS visibility toggle
- **Panel resize during drag** — real-time, no easing
- **Cursor movement** — no animated cursor transitions
- **Live-preview widget decorations** — widgets appear/disappear with the
  cursor; no fade or slide
- **Background textures or grain** — the paper aesthetic is achieved through
  color, not animated texture

---

## Implementation Notes

### CSS Custom Properties for Motion

```css
:root {
  --duration-instant: 0ms;
  --duration-fast: 100ms;
  --duration-normal: 150ms;
  --duration-moderate: 200ms;
  --duration-slow: 300ms;

  --ease-default: cubic-bezier(0.2, 0, 0, 1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1);
  --ease-in: cubic-bezier(0.8, 0, 1, 1);
  --ease-linear: linear;
}
```

### Composing Transitions

Components should compose transitions from tokens:

```css
/* Hover transition */
transition: background-color var(--duration-normal) var(--ease-default);

/* Collapse transition */
transition: height var(--duration-moderate) var(--ease-out),
            opacity var(--duration-moderate) var(--ease-out);
```

Avoid `transition: all` — it transitions properties that shouldn't animate
(layout, box-model) and can cause performance issues. Always list specific
properties.

---

## Responsiveness & Performance Budget

Perceived smoothness is mostly **interaction scheduling**, not animation
design. A calm writing interface that animates beautifully but misses
interaction latency targets will still feel sluggish. This section defines
the operational performance rules.

*Evidence: research `web-smoothness-motion.md` — web.dev RAIL model
([Measure performance with the RAIL model](https://web.dev/articles/rail), updated 2025), web.dev INP
([Interaction to Next Paint](https://web.dev/articles/inp), updated Sep. 2, 2025), web.dev INP optimization
([Optimize Interaction to Next Paint](https://web.dev/articles/optimize-inp), updated Sep. 2, 2025), MDN / React
ViewTransition + `prefers-reduced-motion`, CodeMirror viewport model.*

### INP Budget

> **Decision:** The Interaction to Next Paint (INP) budget is **≤ 200 ms** —
> the "good" threshold per the Core Web Vitals standard. This is an explicit
> design target and a regression gate. Any interaction that regularly
> approaches 200 ms during or after load is a regression candidate.
>
> **Rationale:** RAIL's perceptual thresholds remain the best cognitive model:
> 0–100 ms feels immediate, 100–1000 ms feels like part of a continuous task,
> and >1000 ms breaks focus ([web.dev RAIL](https://web.dev/articles/rail)). INP operationalizes this as a
> stable metric that measures interaction latency across the entire visit.
> Naming an explicit budget turns "feels smooth" into a testable property.
>
> **Rejected:** Leaving responsiveness as an implicit quality with no
> operational budget. Without a named target, regressions are invisible until
> users complain.

**Implementation priorities:**

- **Keep interaction work off the main thread.** Use web workers for
  heavy secondary work; keep event callbacks short.
- **Break work into separate tasks.** Yield to the main thread between
  tasks so the browser can paint the next frame sooner.
- **Avoid layout thrashing.** Never read layout properties immediately
  after writing styles in the same synchronous task — this forces
  synchronous reflow.
- **Minimize DOM size.** Large DOMs make every rendering update more
  expensive. Virtualize long lists and transcripts.

*Sources: web.dev INP optimization guidance, RAIL model.*

### Streaming Text: Yield-Between-Chunks Rule

> **Decision:** Streaming text (LLM responses, token-by-token output,
> incremental transcript rendering) must **batch chunks, yield to the main
> thread between batches, and never perform synchronous reflow-reads after
> writes.** The UI must keep stale content visible while the next chunk loads
> — replacing the entire surface on every token is a jank vector.
>
> **Rationale:** React's `useDeferredValue` and `useTransition` exist
> specifically to keep showing stale content while fresh content loads in the
> background, without blocking user interactions ([React `useDeferredValue`](https://react.dev/reference/react/useDeferredValue),
> [React `useTransition`](https://react.dev/reference/react/useTransition)). The existing FloatingScrollLayout /
> stick-to-bottom behavior in the spec is the correct "keep old content
> visible while the next chunk arrives" pattern. Adding explicit
> yield-between-chunks discipline prevents token streaming from becoming a
> source of interaction jank.
>
> **Rejected:** Rebuilding the entire transcript surface on every incoming
> token. This produces layout shifts, destroys scroll position continuity,
> and makes the surface unresponsive to user input during streaming.

This rule reinforces the existing streaming patterns in the spec:

- **FloatingScrollLayout / stick-to-bottom:** Keep the stable portion
  visible; append in controlled chunks.
- **`useDeferredValue` / `useTransition`:** Defer expensive secondary
  updates (syntax highlighting, decoration recomputation) so the primary
  text surface stays responsive.
- **Chunked streaming on mobile** (`interaction/threads-and-tools.md`
  §Mobile Chat Surface): phrase/sentence-chunk batching is already the
  phone pattern — this rule makes it normative for desktop as well.

### `content-visibility` for Inactive Shells & Long Transcripts

> **Decision:** Inactive mounted mode shells and long transcript/editor
> surfaces use `content-visibility: hidden` (inactive shells) or
> `content-visibility: auto` (scrollable long transcripts) to reduce
> rendering cost while preserving DOM state.
>
> **Rationale:** `content-visibility` lets the browser skip rendering work
> for off-screen or hidden content, which directly reduces layout and paint
> cost ([web.dev content-visibility](https://web.dev/articles/content-visibility), updated Sep. 23, 2025). This reinforces
> the existing mounted-shell + pause-non-essential-work contract
> (`layouts/overview.md` §Active/Inactive Work Contract) by adding a CSS-level
> rendering optimization on top of the JS-level pause rules. For long
> transcripts, `content-visibility: auto` keeps only the visible portion in
> the rendering pipeline.
>
> **Rejected:** Relying solely on JS-level pause rules without CSS-level
> rendering hints. The browser still pays layout cost for hidden-but-mounted
> DOM unless explicitly told to skip it.

### View Transitions API: Optional Polish Only

> **Decision:** The View Transitions API may be used for optional,
> non-essential visual polish, but it must be **skippable** (via
> `skipTransition()`), **reduced-motion-aware** (collapsed to instant when
> `prefers-reduced-motion: reduce` is active), and have a **direct DOM update
> fallback** when `document.startViewTransition` is unavailable. It is never
> a dependency for mode switching or core task completion.
>
> **Rationale:** The API is designed to be optional: `skipTransition()` skips
> the animation while still performing the DOM update
> ([MDN `ViewTransition.skipTransition()`](https://developer.mozilla.org/en-US/docs/Web/API/ViewTransition/skipTransition)), and the browser's default is a
> cross-fade. React's own ViewTransition docs explicitly remind you to check
> `prefers-reduced-motion` — React does not disable animations automatically
> ([React `<ViewTransition>`](https://react.dev/reference/react/ViewTransition)). Mode switching in Meridian is already instant
> (CSS visibility toggle, `0ms` duration); View Transitions must not
> reintroduce latency into that path.
>
> **Rejected:** Using View Transitions as a dependency for mode switching or
> critical UI state changes. This would add latency to the most
> latency-sensitive interaction in the app and would break when the API is
> unavailable or when the user has reduced motion enabled.

### High-Frequency Motion Ceiling

> **Decision:** Animations that fire frequently — hover states, focus rings,
> micro-feedback, icon weight changes — must stay **under ~150 ms duration**.
> This is already reflected in the duration token table (`--duration-normal`
> at 150ms, `--duration-fast` at 100ms).
>
> **Rationale:** The perceptual threshold for "instant" is ~100 ms (RAIL).
> Animations in the 150 ms range occupy a narrow band where the motion is
> visible but does not feel like waiting. Anything longer on a
> high-frequency interaction creates cumulative friction.
>
> **Rejected:** Longer hover/micro-interaction durations (200ms+). Even a
> 50ms increase across every hover event adds up to a perceptibly heavier
> interface over the course of a writing session.
