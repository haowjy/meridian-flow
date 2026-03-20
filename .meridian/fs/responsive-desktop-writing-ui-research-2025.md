# Responsive Desktop-First Writing App Research (2025)

Date: 2026-03-19
Scope: AI-powered fiction-writing platform with three modes (`Studio`, `Converse`, `Agents`), targeting desktop-first usage with acceptable tablet/split-screen behavior.

## Executive Recommendation

1. Use a **three-tier adaptive model** rather than a classic mobile-first breakpoint stack:
- `Expanded (>=1200px)`: full desktop layout (multi-pane, persistent sidebars, drag-resize enabled)
- `Medium (840-1199px)`: keep desktop information architecture, but collapse one secondary pane at a time into overlay/drawer
- `Compact (<=839px)`: single-primary-pane with explicit mode switcher + temporary drawers

2. Treat `Studio`, `Converse`, `Agents` as **separate workspace shells** with independent persisted layout state (panel sizes, visible panes, active tab, scroll position), and explicit restore rules.

3. Use **react-resizable-panels** as the default panel system for React (mature persistence model, keyboard resize, SSR guidance), with Allotment as an alternative if you want VS Code-like resizing behavior out of the box.

4. Build around **state-preserving visibility**, not frequent unmount/remount:
- keep primary mode trees mounted where feasible
- hide via CSS/`hidden` + `inert` + aria controls
- only unmount memory-heavy subtrees with explicit cache policy

5. Default to **touch-safe desktop controls**: 40-48px targets for core actions and 24px minimum hard floor for dense controls.

---

## 1) Responsive panel layouts (VS Code, Linear, Notion, Arc) + libraries

### Observed product patterns

- **VS Code** supports drag/drop relocation of views across primary sidebar, secondary sidebar, and panel region; remembers layout across sessions; includes maximize/floating window options. This is a highly composable desktop model.
- **Linear** supports fully collapsible sidebar (`[` shortcut), optimized for focus-in-place rather than deep reconfiguration.
- **Notion** uses an elastic sidebar (resize, collapse, reopen) and collapsible sections.
- **Arc** treats split views as durable workspace objects (split view becomes a retrievable sidebar item/tab).

### Library landscape (React)

- **react-resizable-panels**: strong choice for app shells; includes `autoSaveId` persistence, conditional panel ordering guidance, SSR cookie+localStorage anti-flicker approach.
- **Allotment**: VS Code-derived splitter behavior; supports min/max/snap/default sizes; useful when you want “IDE feel” quickly.
- **react-split-pane**: still used but older release cadence and less aligned with modern React/SSR needs.
- **GoldenLayout**: powerful docking/popout desktop metaphor, but more complexity and legacy integration overhead.

### Real-world gotchas

- Conditional panels often break size restoration unless panel IDs/order are stable.
- SSR hydration flicker appears when client layout persistence differs from server default.
- Split view focus bugs become high-friction quickly (seen in Arc user reports).

### Recommendation

- Start with `react-resizable-panels` for `Studio` and `Agents`.
- Persist per-mode layout with scoped keys and schema versioning.
- Add deterministic panel IDs and explicit migration logic for removed/renamed panes.

---

## 2) Desktop-first responsive strategy (including 768-1024 awkward zone)

### Proven framing

Material/Android adaptive guidance and Atlassian layout guidance both converge on **window-class thinking**, not device-type thinking.

- Compact `<600dp`
- Medium `600-839dp`
- Expanded `>=840dp`
- Atlassian side-nav guidance includes practical collapsed/default panel widths and breakpoint-conditioned panel behavior.

### Strategy for 768-1024 zone (awkward zone)

This zone is usually “Medium” in practice. It should not be treated as desktop-lite nor mobile.

Recommended behavior:
- Keep desktop navigation model (rail + command palette + keyboard shortcuts)
- Show only one secondary pane at once (e.g., chat OR inspector)
- Convert tertiary panes into temporary overlays
- Preserve state, don’t reset when panes collapse
- Prefer progressive disclosure over global simplification

### Recommendation

Adopt **adaptive desktop**:
- Preserve IA and power-user affordances in medium width
- Reduce simultaneous pane count, not capability set

---

## 3) Mode/workspace switching without losing state

### Core state model

React state is tied to position in render tree; unmount destroys local state. So mode switches that unmount trees cause avoidable state loss.

Patterns:
- **Preferred**: keep mode roots mounted, hide inactive roots visually/accessibly
- **Selective cache**: preserve only expensive subtrees (editor buffers, chat threads, agent runs)
- **Explicit reset boundaries**: use keys to intentionally reset when context changes (e.g., switching projects)

### Framework notes

- Next.js parallel routes can preserve slot state on soft navigation; hard reload requires `default.js` fallback for unmatched slots.
- React Offscreen patterns exist conceptually but are still not mainstream stable API guidance for most production apps.
- Third-party KeepAlive solutions exist but can conflict with modern StrictMode/createRoot behavior (example: `react-activation` caveats).

### Recommendation

- Implement app-level **ModeStateRegistry** keyed by `{workspaceId, mode}`.
- Keep mode shells mounted when memory budget allows.
- For inactive heavy panes, snapshot/restore state instead of naive remount.

---

## 4) Rail/sidebar navigation patterns (VS Code, Slack, Discord, Linear)

### Common pattern stack

- Left rail for mode/global destinations
- Adjacent sidebar for contextual objects (files, issues, channels)
- Collapse/expand on shortcut + hover affordance
- Tooltips when icon-only
- Keyboard traversal between major regions (Discord F6 pattern is a good accessibility reference)

### Practical sizing

- Atlassian guidance: collapsed side nav at `56px`, default `320px` for 768+ layouts.
- VS Code supports compact activity bar mode (useful precedent for dense icon rails).
- Slack allows icons-only vs icon+text sidebar variants.

### Recommendation

- Use `56px` rail baseline, 20-24px icons, tooltip-on-hover/focus, and clear selected-state indicator.
- Sidebar defaults: 280-320px; collapse to 56px icon rail or fully hidden depending on mode.

---

## 5) Panel size persistence

### Persistence options

- `localStorage`: fast, local, best default for per-device ergonomics
- URL params: good for shareable “layout presets” and support/debug links
- server-side profile: best for roaming users, heavier conflict handling required

### What mature tools do

- VS Code persists layout across sessions.
- react-resizable-panels supports automatic persistence (`autoSaveId`) and pluggable storage/cookie strategy.

### Recommendation

Use layered persistence:
1. localStorage immediate restore
2. background sync to server profile (if authenticated)
3. optional URL override for shared views

Add layout schema versioning and migration functions.

---

## 6) Writer-focused UI patterns (fiction workflows)

### Strong patterns across writing tools

- **Focus mode variants** (current line/sentence/paragraph highlight)
- **Typewriter/fixed scrolling** (cursor anchored vertically)
- **Distraction-free full screen** with hidden chrome
- **Theme controls** and editor typography controls (line height, line width)
- **Project decomposition** (scene/chapter cards + timeline/structure views)

### App-specific notes

- iA Writer: sentence/paragraph focus and independent typewriter scrolling; warns focus mode can cause “jumping” during edit-heavy workflows.
- Ulysses: fixed scrolling, line/sentence/paragraph highlight, hide interface/toolbar, full-screen workflow.
- Scrivener: Composition Mode + typewriter scrolling + project-level composition background controls.
- Wavemaker: community usage highlights value in cards/timeline/snowflake planning; also recurring reports of sync/planning-board fragility in community channels.

### Recommendation for fiction writers with 100+ chapters

Must-have set:
- Focus mode toggle with 3 granularity levels
- Typewriter scroll with top/middle/bottom anchor option
- Scene/chapter navigator with status filters
- Fast chapter jump (`Cmd/Ctrl+K` command palette)
- Side-by-side draft vs notes/research pane

---

## 7) Touch-ready desktop components (mouse + touch)

### Baselines

- WCAG 2.2 target size minimum: 24x24 CSS px (hard floor, with spacing exceptions).
- Platform guidance: ~40-48px targets for comfortable touch (Windows guidance ~40px; Material commonly 48dp; Apple guidance commonly 44pt).

### Input handling

- Prefer **Pointer Events** for unified mouse/touch/pen event model.
- Use pointer capture during drag-resize interactions to prevent losing drag when pointer leaves handle.

### Recommendation

- Resize handles: visible 2-4px, but **hit area 12-16px**.
- Core tap targets: 40-48px for primary controls.
- Dense icon actions: allow 24px only with adequate spacing and low-frequency usage.

---

## 8) Below-breakpoint fallback: banner vs simplified mode vs responsive collapse

### Pattern tradeoffs

- **“Desktop recommended” banner only**
  - Pros: low engineering cost
  - Cons: blocks usage, poor perceived quality
- **Simplified single-pane mode**
  - Pros: robust on small screens; easiest mental model
  - Cons: context switching cost; more taps
- **Responsive collapse (adaptive)**
  - Pros: preserves capability and familiarity
  - Cons: complexity; can become cluttered if poorly prioritized

### Real-world references

- Notion/Linear favor collapse + progressive reveal.
- Some tools (e.g., Figma mobile app behavior in community/official forum discussions) use view-oriented constraints rather than full desktop editing parity.

### Recommendation

Use **adaptive collapse first**, then **single-pane fallback** below compact threshold.
Only show “desktop recommended” for actions that are truly impractical on small screens (e.g., multi-agent dashboard with 4+ concurrent panes).

---

## 9) Dark/light mode for long writing sessions

### What works in practice

- Avoid pure #000 backgrounds for long-form writing in many contexts; dark gray backgrounds can reduce harsh contrast and improve legibility perception (Material dark theme guidance aligns with this).
- Maintain WCAG contrast minimums (normal text >=4.5:1); use higher contrast for long reading where possible.
- Offer both warm-light and cool-light themes because comfort is user- and context-dependent.

### Recommended theme set

- `Paper Warm` (day writing): warm off-white background, near-black text
- `Neutral Light`: cooler white-gray background, high readability
- `Soft Dark`: deep gray background, off-white text
- `High Contrast Dark`: for users needing stronger differentiation

Suggested editor defaults:
- line length: 60-90 chars
- line height: 1.45-1.7
- no pure black/white pair by default

---

## 10) Multi-tab document management for 100+ docs

### Patterns from IDE/browser tools

- VS Code: pinned tabs that stay visible and survive tab limits; preview tabs for temporary opens; floating windows and editor groups.
- Chrome: tab groups (named, colored, collapsible), tab search (`Ctrl/Cmd+Shift+A`), multi-tab bulk operations.
- Arc: spaces + pinned tabs + split-view tabs as durable workspace objects.

### Recommendation for long serial writing

Adopt a hybrid model:
- **Pinned chapter tabs** (core working set)
- **Preview tab** for transient opens from explorer/search
- **Recent files stack** with MRU ordering
- **Chapter groups** (Book/Arc/Season)
- **Tab search + command palette** as primary retrieval mechanism

For 100+ chapters, retrieval beats horizontal tab scanning.

---

## Implementation blueprint for Meridian modes

### Studio (VS Code-for-writing)
- 3-pane default on expanded: explorer | editor tabs | chat/inspector
- 2-pane in medium: editor + one secondary pane toggle
- single-pane in compact with quick mode drawer

### Converse (chat-primary)
- expanded: chat primary + resizable editor secondary
- medium: chat full, editor in slide-over or split toggle
- compact: chat only + editor open as modal sheet/fullscreen

### Agents (parallel threads)
- expanded: thread board + detail pane + logs/output pane
- medium: board + one detail pane
- compact: list -> detail navigation stack

---

## Key decisions and tradeoffs

- Prefer adaptive desktop over mobile-first rewrite for medium widths.
- Preserve state aggressively across mode switches to protect writer flow.
- Use local-first persistence with optional server sync.
- Optimize for retrieval/navigation patterns instead of many simultaneously visible tabs.
- Keep touch support first-class without sacrificing mouse/keyboard speed.

---

## Screenshot / mockup descriptions to emulate

1. VS Code custom layout screenshot pattern: left explorer, right assistant sidebar, bottom panel; customizable via title-bar layout controls.
2. Linear collapsed sidebar screenshot pattern: content-focused center with quick shortcut to re-expand.
3. Notion sidebar behavior: elastic width with per-section collapse and keyboard toggle.
4. Arc split-view screenshot pattern: split composition represented as a durable sidebar/tab artifact.

---

## Sources

- VS Code Custom Layout: https://code.visualstudio.com/docs/configure/custom-layout
- VS Code Sidebars UX Guidelines: https://code.visualstudio.com/api/ux-guidelines/sidebars
- react-resizable-panels (GitHub): https://github.com/bvaughn/react-resizable-panels
- react-resizable-panels (npm): https://www.npmjs.com/package/react-resizable-panels
- Allotment (GitHub): https://github.com/johnwalley/allotment
- Allotment (npm): https://www.npmjs.com/package/allotment
- react-split-pane (npm): https://www.npmjs.com/package/react-split-pane
- GoldenLayout docs: https://golden-layout.github.io/golden-layout/
- Notion sidebar help: https://www.notion.com/help/navigate-with-the-sidebar
- Linear collapsible sidebar changelog: https://linear.app/changelog/unpublished-collapsible-sidebar
- Linear peek docs: https://linear.app/docs/peek
- Slack sidebar preferences: https://slack.com/help/articles/212596808-Adjust-your-sidebar-preferences
- Discord keyboard navigation: https://support.discord.com/hc/en-us/articles/1500000056121-Keyboard-Navigation-FAQ
- Arc split view/multitasking: https://start.arc.net/master-multitasking
- Arc pinned tabs: https://resources.arc.net/hc/en-us/articles/19231060187159-Pinned-Tabs-Tabs-you-want-to-stick-around
- Arc spaces: https://resources.arc.net/hc/en-us/articles/19228064149143-Spaces-Distinct-Browsing-Areas
- React preserving/resetting state: https://react.dev/learn/preserving-and-resetting-state
- Next.js parallel routes: https://nextjs.org/docs/app/api-reference/file-conventions/parallel-routes
- React 18 reusable state discussion (Offscreen context): https://github.com/reactwg/react-18/discussions/19
- react-activation KeepAlive caveats: https://github.com/CJY0208/react-activation
- Android large screens & window classes: https://developer.android.com/design/ui/large-screens
- Android adaptive window size classes: https://developer.android.com/develop/ui/compose/layouts/adaptive/use-window-size-classes
- Atlassian layout grid + side nav sizing: https://atlassian.design/foundations/grid-beta/
- WCAG 2.2 target size minimum (24px): https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- WCAG target size 44px example: https://www.w3.org/WAI/WCAG21/working-examples/css-44px-target-size/
- Windows touch targeting guidance: https://learn.microsoft.com/en-us/windows/apps/develop/input/guidelines-for-targeting
- MDN Pointer Events: https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events
- Apple WWDC target size mention (44pt): https://developer.apple.com/videos/play/wwdc2024/10085/
- iA Writer Focus Mode: https://ia.net/writer/support/editor/focus-mode
- Ulysses details/tips: https://help.ulysses.app/en_US/getting-started/details-and-tips
- Ulysses editor customization: https://help.ulysses.app/en_US/dive-into-editing/editor-customization-guide
- Ulysses keyboard shortcuts: https://help.ulysses.app/en_US/keyboard-shortcuts-mac-ipad
- Scrivener 3 quick reference (composition/typewriter): https://content.app-sources.com/s/438414006338650411/uploads/PDFs/Scrivener_3_for_Windows_Quick_Reference-0773047.pdf
- Chrome tab management (groups/search/bulk): https://support.google.com/chrome/answer/2391819?co=GENIE.Platform%3DDesktop&hl=en-CA
- Material dark theme palette rationale: https://design.google/library/material-design-dark-theme
- WCAG contrast technique (4.5:1): https://www.w3.org/WAI/WCAG21/Techniques/general/G18.html

