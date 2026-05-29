# Meridian Frontend v2 — Design Language Specification

**Version:** 1.0  
**Date:** 2026-05-29  
**Status:** Authoritative — all product decisions resolved

---

## Purpose

This specification defines the unified design language for the Meridian
frontend rebuild (`frontend-v2/`). It is the single authoritative blueprint
that all future implementation builds from. All previously open product
decisions have been resolved (see §Decisions for Sign-Off). Every visual decision, layout
rule, interaction pattern, and token definition lives in this doc tree.

This phase produces **documentation only** — no code, no Storybook builds, no
visual mockups.

## Design Principles

Five principles govern every decision in this spec. When two choices are
otherwise equal, the one that better satisfies these principles wins.

### 1. The prose is the product

Every UI element exists to support the writing. The editor surface, the
conversation thread, the document tree — they serve the writer's text. Chrome
that doesn't directly support reading, writing, or reviewing prose must justify
its existence. When in doubt, remove it.

### 2. Literary calm over dashboard density

Meridian feels like a focused writing tool, not a project management dashboard.
Warm neutrals, generous whitespace, restrained motion, low chrome. The "paper
aesthetic" — warm cream in light mode, warm espresso in dark — is the
signature visual identity and the primary market differentiator.

*Evidence: iA Writer, Ulysses, Bear, and Linear all demonstrate that reducing
visual noise and letting typography carry the interface creates a calmer,
more focused experience (design-language-best-practices §5).*

### 3. Typography-forward

Type does most of the visual work. Size, weight, and spacing changes create
hierarchy — not color fills, borders, or icons. Three fonts serve three
distinct roles: Geist for UI chrome, iA Writer Quattro for prose, Geist Mono
for code and metadata. The type scale is small and intentional.

*Evidence: Best-practice research recommends a modest, related set of sizes
and a clear font-per-role split for calm writing UIs
(design-language-best-practices §2).*

### 4. Writer-first interaction language

The writer is the author making creative choices about their text. UI
language reflects this: "Keep" / "Edit" / "Discard" for review actions, not
code-review jargon like "Accept" / "Reject." The writer owns the prose; the
assistant proposes.

### 5. Progressive disclosure, not progressive overload

Default to the quietest version of every surface. Show what's needed for the
current task; hide everything else behind intentional expansion. Tool activity
is summarized, not streamed raw. Panels collapse. Sidecars fold away. The
writer controls attention.

*Evidence: Calm Technology principles — inform without demanding, use the
periphery before the center (interaction-best-practices §5).*

## Product Posture

Meridian is a **serious creative tool** for fiction writers managing 100+
chapter web serials. Not playful, not corporate. The paper aesthetic is the
key differentiator. Cultivation/xianxia origin is an Easter egg, not
marketing.

- **Responsive-first (desktop + mobile co-equal).** The three-mode
  architecture works across Phone, Tablet, and Desktop tiers. Desktop is
  the full multi-pane experience; Phone and Tablet have deliberately designed
  forms with BottomNav, single-pane layouts, drawers, bottom sheets, and
  touch-native editing. Neither is a degraded version of the other. See
  `foundations/responsive.md`.
- **Single-user MVP.** Multi-user is not precluded, but not designed for in
  this phase. The Yjs collab infrastructure exists for future use.
- **Storybook-first build methodology.** Every component is built in isolation,
  exercised with stories, then integrated into layouts.

## How to Read This Spec

Each document is self-contained and focused on one concern (SRP). Cross-
references use relative paths. Canonical terms from `vocab.md` are used
throughout — consult it when a term is unfamiliar.

### Doc Tree

```
design/
  overview.md              ← You are here
  foundations/
    tokens.md              # Primitive + semantic token system, @theme mapping
    typography.md          # Type scale, measure, leading, font roles
    color.md               # Paper/Espresso, accent system, WCAG rules
    motion.md              # Duration/easing tokens, calm-motion principles
    elevation.md           # Elevation/shadow token scale
    responsive.md          # Tier system, breakpoints, viewport/safe-area tokens, touch rules
  components.md            # Atomic inventory + composites, states, variants, mobile composites
  layouts/
    overview.md            # Rail/BottomNav + mode switching, responsive tiers, state scoping
    agents.md              # Agents mode — session orchestration + mobile form
    converse.md            # Converse mode — chat-primary + mobile form
    studio.md              # Studio mode — editor-primary + mobile form
  interaction/
    threads-and-tools.md   # Turns, tool/thinking groups, streaming display, mobile chat
    proposals-review.md    # Hunks, review flow, action language, decoration order, touch review
    editor.md              # Live preview, decoration layers, formatting toolbar, touch editing
    navigation.md          # Mode switching, tabs, Mod+P, keyboard map, touch gestures
```

### Conventions

- **Decision boxes** mark resolved ambiguities with rationale:
  > **Decision:** [choice]. **Rationale:** [why]. **Rejected:** [alternative].
- **Sign-off items** are collected in §Decisions for Sign-Off below.
- Token names use `--kebab-case` and are Tailwind v4 `@theme`-compatible.
- OKLCH is the color space for all token definitions. Hex equivalents are
  provided for reference only.
- Phosphor Icons are the icon library; specific icon names reference the
  Phosphor catalog.

## Stack Constraints

The spec must remain implementable on the committed stack:

| Layer | Technology |
|---|---|
| Styling | Tailwind CSS v4 with `@theme inline` CSS variables |
| UI primitives | shadcn/ui (new-york style) + Radix + Ark UI (TreeView) |
| Icons | Phosphor Icons (`@phosphor-icons/react`) |
| UI font | Geist Variable |
| Prose font | iA Writer Quattro |
| Code font | Geist Mono Variable |
| Editor | CodeMirror 6 |
| Collab | Yjs |
| Panels | react-resizable-panels |
| Router | TanStack Router (Phase 8) |

---

## Decisions for Sign-Off

The following choices were made with explicit rationale in this spec. All
previously open items have been resolved as of 2026-05-29.

### Confirmed by prior direction (no action needed)

1. **Visual personality: literary & calm** — paper aesthetic, warm neutrals,
   jade-teal accent, generous whitespace, low chrome.
2. **Deliverable: docs only** — no code this phase.
3. **Review action language: "Keep / Edit / Discard"** — writer-first,
   consistent with current production code and `vocab.md`.
4. **Responsive-first** — desktop + mobile co-equal (replaces earlier
   "desktop-first" posture).

### Design decisions (review for alignment)

5. **Rail active indicator: left accent bar** (not icon fill). Chose left bar
   for consistency with VS Code/Linear convention and lower visual weight.
   See `layouts/overview.md`.

6. **Chat message alignment: full-width, role-distinguished by subtle
   background** (not left/right bubble alignment). Full-width maximizes the
   reading column and matches the editorial feel. See
   `interaction/threads-and-tools.md`.

7. **Panel resize defaults** defined per mode. See `layouts/converse.md` and
   `layouts/studio.md` for exact ratios.

8. **Accent-text usage rule:** `accent-text` for any teal-colored text;
   `accent-fill` only for icons, borders, fills, and decorative surfaces.
   See `foundations/color.md`.

9. **Agents mode layout: session timeline + thread family cards** with a
   drill-in detail pane. See `layouts/agents.md`.

### Resolved (confirmed 2026-05-29)

10. **Project ↔ Session cardinality: multiple sessions per project.**
    > **Decision:** A project contains multiple sessions. A session is a bounded
    > unit of related work (e.g., "Chapter 12 revision," "Continuity audit for
    > Arc 3") containing multiple related threads. Agents mode surfaces session-
    > level orchestration.
    >
    > **Rationale:** Fiction writers managing 100+ chapter serials have multiple
    > concurrent concerns. A flat thread list with optional grouping cannot
    > adequately express the parallel-work model.
    >
    > **Rejected:** 1:1 Project↔Session. This collapses Agents mode to a simple
    > thread list and eliminates the session-orchestration surface.
    >
    > See `layouts/agents.md` §Data Model.

11. **Tab creation from Converse: hybrid preview→promote.**
    > **Decision:** A "Review" action in Converse opens the document as a
    > **transient preview** — a single reused slot with an italic title, replaced
    > by the next preview. The preview **promotes to a persistent Studio tab**
    > on explicit commitment: editing the document, acting on a hunk
    > (Keep/Edit/Discard), pinning the tab, or double-clicking the tab title.
    >
    > **Rationale:** This is the VS Code preview-tab pattern. Transient previews
    > don't clutter Studio with tabs the writer only glanced at, but commitment
    > is effortless — any interaction that signals intent promotes the tab.
    >
    > **Rejected:** Always create a real tab (clutters Studio). Never create a
    > tab (forces the writer to manually open the file in Studio).
    >
    > See `layouts/converse.md` §Interaction Flows, `layouts/studio.md` §Tab Bar.

12. **Wiki-links (`[[page]]`) carry forward.**
    > **Decision:** Wiki-link support is preserved in v2 as a decoration layer
    > with resolution, creation popover, and broken-link detection.
    >
    > **Rationale:** Wiki-links are a core navigation mechanism for fiction
    > writers linking between chapters, characters, and lore. Removing them
    > would be a significant feature regression.
    >
    > See `interaction/editor.md` §Wiki-Links.

13. **Focus mode: included.**
    > **Decision:** Focus mode is in scope. Core = hide rail + collapse all
    > secondary panes to an editor-only canvas, editor centered at
    > `--editor-measure`. Paragraph-dimming is an **optional refinement** — a
    > CM6 decoration dimming non-cursor paragraphs, slotted into the canonical
    > layer order. One web-safe toggle shortcut (`Mod+Shift+\`), `Esc` out;
    > respects `prefers-reduced-motion`.
    >
    > **Rationale:** Distraction-free writing is a primary use case for a
    > writing tool. The core mode (hide chrome) is low-effort to implement;
    > paragraph-dimming is a nice-to-have polish feature.
    >
    > See `interaction/editor.md` §Focus Mode.

14. **Mobile: co-equal, all three modes.**
    > **Decision:** Mobile is co-equal with desktop. All three modes (Agents,
    > Converse, Studio) have a full mobile experience with deliberate Phone
    > and Tablet forms, including touch editing (CM6) and touch proposal review.
    > Three responsive tiers: Phone (< 600px), Tablet (600–1199px), Desktop
    > (≥ 1200px). BottomNav replaces the Rail on Phone; Tablet uses BottomNav
    > in portrait, Rail in landscape.
    >
    > **Rationale:** Fiction writers use phones and tablets for reading,
    > reviewing, light editing, and chat-first workflows. A desktop-only
    > product loses the writer during commutes, reading sessions, and quick
    > review passes. The strongest exemplars (Notion, Linear, Obsidian,
    > Ulysses, Bear) treat mobile as a distinct product form.
    >
    > **Rejected:** "Desktop-first with graceful degradation" (the prior
    > decision) — produces a compressed desktop that is usable but not good.
    > "Mobile-first" — the product's primary editing surface is genuinely
    > desktop-optimized; mobile-first would underserve the core use case.
    >
    > See `foundations/responsive.md` for the full tier system, viewport
    > tokens, and safe-area rules.
