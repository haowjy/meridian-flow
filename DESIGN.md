---
version: alpha
name: Warm Paper
summary: Meridian Flow writing workbench UI — calm editorial surfaces, warm neutrals, restrained green accent, and long-session readability.
tokens:
  canonicalPackage: "@meridian/design-tokens"
  canonicalCss: "packages/design-tokens/src"
  appCss: "apps/app/src/styles/globals.css"
principles:
  - writing-first
  - calm-density
  - continuity-is-trust
  - optimistic-motion
  - tokens-not-one-offs
---

# Design System: Meridian Flow — Warm Paper

Agent-facing visual identity for `@meridian/app`. This is a pointer document: token values belong in `@meridian/design-tokens`, while app-only utilities live in `apps/app/src/styles/globals.css`. Do not add raw color values or magic layout numbers in TSX; promote repeated visual decisions into tokens or shared primitives.

## Overview

Warm Paper is the v3 workbench aesthetic: a calm writing environment with warm neutral surfaces, restrained green accenting, editorial rhythm, and compact metadata. It should support long drafting and review sessions without making the writer feel like they are operating infrastructure.

- **Audience:** fiction writers managing long-running serials, chapters, continuity notes, and agent-assisted revision threads.
- **Mood:** warm paper, quiet structure, capable engine.
- **Density:** comfortable reading/drafting rhythm in the main column; compact but legible metadata in rails and rows.
- **Scope:** authenticated app shell, project/workbench views, chat/thread surfaces, context/document surfaces, and marketing-adjacent pages that share the brand language.

## Color roles

Use semantic tokens from `@meridian/design-tokens` instead of literal values:

- `background` — default page/workbench wash.
- `foreground` — primary text and headings.
- `primary` — brand/action/live-state accent.
- `card` — elevated cards, dialogs, and popovers.
- `surface-subtle` — soft fills such as user-message and quiet panel backgrounds.
- `border` / `border-subtle` / `border-focus` — structural edges and focus affordance.
- `ink-strong` / `ink-muted` / `ink-subtle` — editorial hierarchy inside dense UI and prose-adjacent surfaces.
- `destructive` — errors and irreversible actions.

## Typography

Use the shared sans/heading tokens and app prose utilities. Long-form text must prioritize readability and stable rhythm over decorative styling.

| Role | Use |
|---|---|
| Hero headline | Home greeting and sparse marketing emphasis |
| Section headline | Shell and panel section titles |
| Body | Forms, rows, and ordinary UI copy |
| Small / extra small | Compact rows, counts, timestamps, labels |
| Meta / eyebrow | Section labels, pills, provenance labels |
| Answer / prose | Streaming thread text, markdown, draft-adjacent explanations |

Markdown and streaming answers should share the same prose token layer so final and in-progress text do not visually jump.

## Layout

The app is a viewport-locked shell with designated internal scroll regions. Avoid page-level scroll fights and horizontal overflow patches at leaf nodes; preserve the boundary chain from shell to pane to content column.

Core shell expectations:

- top-level app frame owns viewport height and hides page overflow;
- rails/chrome are stable flex children, not ad-hoc overlays;
- central writing/chat/context areas own their own scroll behavior;
- pinned composers and toolbars reserve enough content clearance to avoid occluding the last line;
- routes swap meaningful work surfaces rather than stacking hidden panels.

## Interaction

- Prefer optimistic local state where the server can reconcile safely.
- Use skeletons or stable live-status rows instead of spinner-first waiting states.
- Keep keyboard focus visible, quiet, and consistent.
- Respect reduced motion; motion should clarify location or state, not perform for its own sake.
- Show model/thread/process depth only when it helps the writer understand or recover from a situation.

## Implementation rules

- Shared visual decisions go in `@meridian/design-tokens` or app-level CSS utilities.
- Components consume semantic classes/vars, not literal colors.
- Feature surfaces should compose existing UI primitives before adding new ones.
- App code should preserve the product language: projects, works, chapters, context, threads, agents, turns.
- Infrastructure language belongs in debug/admin surfaces, not primary writing flows.
