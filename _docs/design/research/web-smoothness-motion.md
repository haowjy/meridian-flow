# Research: perceived smoothness & motion in calm/productivity web apps

*Date:* 2026-05-29  
*Scope:* React web app motion + responsiveness for a calm/minimal writing interface.  
*Method:* current web docs and current platform guidance; treat sources as evidence, not prescriptions.

## Executive summary

The strongest current guidance is consistent across Apple, Material, W3C, and web.dev: motion should explain state changes, stay brief, and never become a second source of latency. For a calm writing app, the right model is:

- **User-perceived speed:** treat **0–100 ms** as “instant,” **100–1000 ms** as acceptable for task continuity, and **>1000 ms** as likely to break focus; **>10 s** is abandonment territory. RAIL still captures this well, and INP now operationalizes responsiveness as a Core Web Vital.  
- **Motion discipline:** animate transitions, not resting states; keep durations short; prefer deceleration/ease-out on exits; and cap ordinary UI motion around the 300 ms range.
- **Accessibility is non-optional:** `prefers-reduced-motion` should collapse motion to effectively instant, and interaction-triggered motion must be disabled or toned down unless it is essential.
- **Architecture matters as much as animation:** keep interaction work off the main thread, avoid layout thrashing, minimize DOM size, virtualize large content, and split heavy work so the browser can paint the next frame quickly.
- **For large, streaming text experiences:** the best patterns are “keep the old content while the next chunk is loading,” “yield between chunks,” and “keep inactive shells mounted/hidden rather than repeatedly destroying and recreating them.”

## Sourced findings

### 1) Motion should explain state changes, not decorate the interface

- **Apple HIG** says motion should be purposeful and brief; brief, precise animated feedback feels lightweight and unobtrusive, and it can convey status/feedback more effectively than prominent animation.  
  Source: Apple Human Interface Guidelines, Motion (updated June 10, 2024): https://developer.apple.com/design/human-interface-guidelines/motion

- **Material Design** frames motion as responsive and natural: transitions should be short, frequent interactions should not feel like waiting, and exiting elements may use shorter durations. Their current duration guidance says:
  - mobile transitions are typically around **300 ms**
  - entering elements around **225 ms**
  - leaving elements around **195 ms**
  - transitions over **400 ms** may feel too slow  
  Source: Material Design, Duration & easing (current docs; crawled 2026-05-29): https://m1.material.io/motion/duration-easing.html

- **Calm Technology** emphasizes small attention cost, ambient awareness, and keeping the user in their task. It explicitly frames good calm systems as those that communicate without pulling the user out of the environment or task.  
  Source: CalmTech.com / Calm Tech Institute principles (current docs; crawled 2026-05-29): https://calmtech.com/ and https://www.calmtech.institute/calm-tech-principles

**Takeaway:** motion in a writing app should mostly be a short “punctuation mark” for state change: open/close, appear/disappear, confirm, and orient. It should not become a background aesthetic.

---

### 2) Perceived latency thresholds still matter, and INP is the modern budget you should watch

- The **RAIL model** gives the clearest perceptual thresholds for UI responsiveness:
  - **0–100 ms:** feels immediate
  - **100–1000 ms:** feels like part of a continuous task
  - **>1000 ms:** users lose focus
  - **>10000 ms:** users are frustrated and likely to abandon  
  It also recommends completing user-input-driven transitions in under 100 ms and producing frames in about 10 ms during animation work.  
  Source: web.dev, Measure performance with the RAIL model (published 2019, current article updated 2025): https://web.dev/articles/rail

- **INP** is now the stability-focused responsiveness metric you should use operationally. web.dev describes INP as a stable Core Web Vital that measures the latency of interactions across the entire visit, with a good target of **200 ms or less**.  
  Source: web.dev, Interaction to Next Paint (published 2022, updated Sep. 2, 2025): https://web.dev/articles/inp

- The INP optimization guide breaks interaction latency into **input delay, processing duration, and presentation delay**. It also explicitly calls out:
  - main-thread work during load as a cause of slow interactions
  - long tasks from script evaluation
  - breaking work into separate tasks
  - yielding to the main thread so rendering can happen sooner  
  Source: web.dev, Optimize Interaction to Next Paint (published May 19, 2023, updated Sep. 2, 2025): https://web.dev/articles/optimize-inp

**Takeaway:** if motion “feels smooth,” but the app is still missing INP targets, the experience will still feel sluggish. Smoothness is a combination of motion design and interaction scheduling.

---

### 3) Reduced motion is a requirement, not a nice-to-have

- **WCAG SC 2.3.3 (Animation from Interactions)** says interaction-triggered motion must be disableable unless it is essential to functionality or the conveyed information. The understanding doc explicitly recommends supporting user motion preferences and removing unnecessary motion.  
  Source: W3C WAI, Understanding SC 2.3.3 Animation from Interactions (updated 2025-09-16): https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html

- **MDN** describes `prefers-reduced-motion` as the CSS media feature for detecting that the user wants minimized movement/animation. MDN also notes that this preference is used to remove, reduce, or replace motion-based animations, and warns that scaling/panning can be vestibular triggers.  
  Source: MDN, `prefers-reduced-motion` (current docs; last modified Nov. 7, 2025): https://developer.mozilla.org/en-US/docs/Web/CSS/%40media/prefers-reduced-motion

- **React’s own ViewTransition docs** explicitly remind you to check `prefers-reduced-motion`; React does not disable animations for you automatically.  
  Source: React docs, `<ViewTransition>` (current docs; crawled 2026-05-29): https://react.dev/reference/react/ViewTransition

**Takeaway:** the reduced-motion path should be a first-class code path, not an override bolt-on.

---

### 4) Keep interactions off the main thread and avoid layout thrashing

- web.dev’s INP guidance says to use **web workers** for JavaScript off the browser’s main thread, keep event callbacks short, and break work into separate tasks so other interactions can run sooner. It also warns that large DOMs make rendering updates expensive in response to interactions.  
  Source: web.dev, Optimize Interaction to Next Paint (updated Sep. 2, 2025): https://web.dev/articles/optimize-inp

- The same guide defines **layout thrashing** as the pattern of updating styles and then reading layout in the same task, forcing synchronous layout work.  
  Source: web.dev, Optimize Interaction to Next Paint (updated Sep. 2, 2025): https://web.dev/articles/optimize-inp

- The **RAIL** article explicitly recommends using idle time to complete deferred work, but only in short chunks, and says user interactions should interrupt idle work.  
  Source: web.dev, Measure performance with the RAIL model (updated 2025): https://web.dev/articles/rail

**Takeaway:** for a calm interface, the “smooth” part is often just: do less synchronously, yield sooner, and let the browser paint.

---

### 5) View transitions are useful, but should remain an enhancement

- The **View Transition API** is now a practical browser primitive for animating between DOM states in SPAs/MPAs. MDN and Chrome explain that the API can animate between states and that the browser’s default is a **cross-fade**.  
  Sources: MDN View Transition API (current docs; last modified Dec. 9, 2025): https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API  
  Chrome for Developers, Same-document view transitions for SPAs (updated Sep. 25, 2024): https://developer.chrome.com/docs/web-platform/view-transitions/same-document

- The API is explicitly designed to be **skippable**. `skipTransition()` skips the animation but still performs the DOM update. That makes it compatible with a “motion is optional” philosophy.  
  Source: MDN, `ViewTransition.skipTransition()` (last modified Dec. 19, 2024): https://developer.mozilla.org/en-US/docs/Web/API/ViewTransition/skipTransition

- Chrome’s guide also shows the correct fallback: if `document.startViewTransition` is unavailable, update the DOM directly.  
  Source: Chrome for Developers, Same-document view transitions for SPAs (updated Sep. 25, 2024): https://developer.chrome.com/docs/web-platform/view-transitions/same-document

**Takeaway:** if we use view transitions at all, they should be optional polish for non-critical transitions, not a dependency for mode switching or core task completion.

---

### 6) Streaming text UIs: preserve continuity, yield between chunks, and avoid jank

- **React `useDeferredValue`** exists specifically to keep showing stale content while fresh content is loading. React renders the old value first, then re-renders in the background with the new value. The docs also note that background re-renders are interruptible.  
  Source: React docs, `useDeferredValue` (current docs; crawled 2026-05-29): https://react.dev/reference/react/useDeferredValue

- **React `useTransition`** says work scheduled in a Transition runs in the background without blocking user interactions, and the UI stays responsive while it is in progress.  
  Source: React docs, `useTransition` (current docs; crawled 2026-05-29): https://react.dev/reference/react/useTransition

- web.dev recommends **breaking work into separate tasks** and **yielding to the main thread** so rendering logic can run sooner. This is directly relevant to chunked streaming, token-by-token output, and incremental transcript rendering.  
  Source: web.dev, Optimize Interaction to Next Paint (updated Sep. 2, 2025): https://web.dev/articles/optimize-inp

- `content-visibility: auto` can materially improve performance on **chunked content areas**, and inactive app views can be left in the DOM with `content-visibility: hidden` to keep cached state while hiding display.  
  Source: web.dev, content-visibility (updated Sep. 23, 2025): https://web.dev/articles/content-visibility

**Takeaway:** for streaming LLM/chat text, the best-feeling UI usually does not “rebuild the whole transcript every token.” It keeps the stable portion visible, appends in controlled chunks, and defers expensive secondary updates.

---

### 7) Heavy editors like CodeMirror 6 are designed around viewport rendering and measured layout

- CodeMirror’s docs say it does **not render the entire document** when the document is large; it renders the visible portion plus a margin, specifically to keep the editor responsive and resource use low.  
  Source: CodeMirror System Guide (current docs; crawled 2026-05-29): https://codemirror.net/docs/guide/

- CodeMirror’s reference manual says that if a block decoration changes height, you should call `requestMeasure` so the editor can update its vertical layout information.  
  Source: CodeMirror Reference Manual (current docs; crawled 2026-05-29): https://codemirror.net/docs/ref/

- CodeMirror’s own docs emphasize that updates should minimize reflows and that custom DOM reads should be scheduled via `requestMeasure`.  
  Source: CodeMirror System Guide (current docs; crawled 2026-05-29): https://codemirror.net/docs/guide/

**Takeaway:** for a heavy editor surface, responsiveness comes from respecting the editor’s viewport model, not from trying to force every view into a single mount/unmount cycle.

---

## Agreement vs. our current spec

### What the current spec gets right

- **Motion token set (0 / 100 / 150 / 200 / 300 ms)** is well aligned with current guidance:
  - 0 ms for immediate state changes
  - 100–150 ms for micro-interactions
  - 200 ms for expand/collapse or lightweight overlays
  - 300 ms as an upper bound for ordinary UI transitions  
  This matches the perceptual thresholds from RAIL and the practical duration bands in Material Design.  

- **Instant mode switch via CSS toggle of mounted shells** is aligned with INP / RAIL and with web.dev’s recommendation to keep inactive views around when appropriate rather than doing expensive repeated teardown/rebuild work.

- **`prefers-reduced-motion` collapse** is correct and should remain mandatory.

- **SessionPool warm-session pool** is directionally correct for a calm app: pre-warm the expensive thing before the user needs it, so task-level interaction stays instant.

- **FloatingScrollLayout / stick-to-bottom behavior** is consistent with the “keep the old content visible while the new content arrives” pattern used by React’s deferred rendering guidance.

### What I would tighten or add

1. **Make INP an explicit design target.**  
   The spec talks about “smooth” and “responsive,” but the implementation should name an operational target:
   - aim for **≤ 200 ms INP**
   - audit the worst interactions during load and after load
   - treat any interaction that regularly approaches 200 ms as a regression candidate  
   Evidence: web.dev INP guidance (updated 2025).

2. **Add a “yield before render” rule for streaming.**  
   Streaming text should explicitly:
   - batch chunks
   - yield between chunks
   - avoid synchronous reflow reads after writes  
   Evidence: web.dev INP optimization guidance.

3. **Consider `content-visibility` for inactive shells and long transcripts.**  
   This is a strong fit for “mounted but hidden” UI regions. It lets you preserve state while reducing rendering cost.

4. **Treat View Transitions API as optional enhancement, not core behavior.**  
   Useful for some non-critical view changes, but:
   - keep mode switching instant
   - skip transitions when reduced motion is on
   - provide a direct DOM update fallback  
   Evidence: MDN + Chrome docs.

5. **Document the editor/layout contract.**  
   For CodeMirror-like surfaces, any operation that changes block height or visible geometry should be treated as a measured update, not as an eager DOM mutation.

6. **If you animate anything that happens often, keep it under ~150 ms.**  
   Hover/focus/tiny feedback should stay very short; otherwise it starts to feel like friction instead of confirmation.

## Missing items worth considering

- **INP in product QA and perf budgets**: this is the big omission if the goal is “smooth and responsive.”
- **View Transitions API**: useful for optional, non-essential transitions; not a requirement, but worth evaluating.
- **`content-visibility` / inactive-view preservation**: especially useful for large shells, long transcripts, and hidden panels.
- **Explicit main-thread yielding strategy**: `startTransition`, `useDeferredValue`, chunking, and/or web workers for heavier secondary work.
- **Large-DOM guardrails**: if transcript or editor surfaces grow unbounded, performance will drift even if individual animations are well designed.

## Bottom line

The current spec is already directionally correct. The main upgrades from current web guidance are:

1. make **INP** explicit,
2. treat **reduced motion** as a hard requirement,
3. keep **mode switching instant**,
4. preserve continuity with **mounted/hidden shells** and **deferred streaming**, and
5. reserve any extra motion—including **View Transitions**—for optional polish only.

In a calm writing app, the best motion is the motion the user barely notices because the app answered immediately.
