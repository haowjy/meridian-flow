---
version: alpha
name: Ink & Jade
summary: Meridian Flow writing project UI — fiction-native skin with Quiet Pro surfaces, ink type, jade actions, and scarce cinnabar seal accents.
tokens:
  canonicalPackage: "@meridian/design-tokens"
  canonicalCss: "ink-jade.css"
  appCss: "apps/app/src/styles/globals.css"
principles:
  - writing-first
  - calm-density
  - continuity-is-trust
  - optimistic-motion
  - tokens-not-one-offs
---

# Design System: Meridian Flow — Ink & Jade

Agent-facing visual identity for `@meridian/app`. Token values live in `@meridian/design-tokens/ink-jade.css`; app-only utilities live in `apps/app/src/styles/globals.css`. Do not add raw color values or magic layout numbers in TSX; promote repeated visual decisions into tokens or shared primitives.

## Overview

Ink & Jade is the v3 project aesthetic: a calm writing environment with Quiet Pro warm-grey surfaces (cooler, low-chroma — not bright white cards), near-black ink type, jade primary actions, and cinnabar reserved for seal moments. It should support long drafting and review sessions without making the writer feel like they are operating infrastructure.

- **Audience:** fiction writers managing long-running serials, chapters, continuity notes, and agent-assisted revision threads.
- **Mood:** ink on warm paper, quiet structure, capable engine.
- **Density:** comfortable reading/drafting rhythm in the main column; compact but legible metadata in rails and rows.
- **Scope:** authenticated app shell, project views, chat/thread surfaces, context/document surfaces, and marketing-adjacent pages that share the brand language.

**Skin, not shell.** This direction changes identity only — color tokens, typography, accent semantics, texture, brand mark, login hero. Layout, sidebar structure, and composer anatomy stay Voluma-style; restyle tokens, never behavior or layout.

## Color roles

Use semantic tokens from `@meridian/design-tokens/ink-jade.css` instead of literal values:

- `background` — Quiet Pro canvas (mid rest tone; chrome recedes below, cards lift above).
- `foreground` — ink type for primary text and headings.
- `primary` / `jade-text` — jade fill for actions; jade-text for links and labels (fill fails AA on page).
- `card` / `surface-warm` — raised surfaces (message bubbles, composer field, cards).
- `sidebar` — chrome step (left rail + right dock).
- `cinnabar` — **scarce seal only:** favorite/pinned, brand mark, destructive deletions. Never routine selection or active rows (red reads as error).
- `destructive` — errors and irreversible actions (distinct from cinnabar).
- `border` / `border-subtle` / `border-focus` — hairline separation; depth reads in surfaces, not shadows.
- `ink-strong` / `ink-muted` / `ink-subtle` — editorial hierarchy inside dense UI and prose-adjacent surfaces.

## Typography

One font everywhere in the app — **Inter** — loaded via Google Fonts in the app
root layout:

| Role | Font | Use |
|---|---|---|
| Everything | Inter | UI chrome, manuscript editor, rendered markdown, conversation turns, headings, login |

Headings and emphasis are differentiated by **size + weight only**, never by a
separate family — matching stock ProseMirror/TipTap (which ship no heading font).
Long-form text must prioritize readability and stable rhythm (~68ch measure,
generous leading). Markdown and streaming answers share the same prose token
layer so final and in-progress text do not visually jump.

The marketing site (`apps/www`) keeps a **Fraunces** landing hero as a
deliberate, isolated branding exception.

## Login

Branded split hero (deep ink ground, needle mark, Inter wordmark, corner seal chop). Credentials and account creation are **WorkOS AuthKit hosted sign-in** — the right card hands off to WorkOS; Meridian owns visual identity, not the auth form. Dev login remains available in development.

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

- Shared visual decisions go in `@meridian/design-tokens/ink-jade.css` or app-level CSS utilities.
- Components consume semantic classes/vars, not literal colors.
- Feature surfaces should compose existing UI primitives before adding new ones.
- App code should preserve the product language: projects, works, chapters, context, threads, agents, turns.
- Infrastructure language belongs in debug/admin surfaces, not primary writing flows.
