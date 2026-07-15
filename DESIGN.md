---
version: alpha
name: Earthen Value Ladder
summary: Meridian Flow writing project UI — one grey-gold chrome family (shelf a shade darker), warm paper, black ink, jade actions, and scarce cinnabar seals.
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

# Design System: Meridian Flow — Earthen Value Ladder

Agent-facing visual identity for `@meridian/app`. Token values live in `@meridian/design-tokens/ink-jade.css`; app-only utilities live in `apps/app/src/styles/globals.css`. Do not add raw color values or magic layout numbers in TSX; promote repeated visual decisions into tokens or shared primitives.

## Overview

The writer workspace uses one warm, near-neutral value ladder so the manuscript
remains the visual center. The whole shell is a single warm grey-gold family:
the left shelf is that chrome one shade darker, one continuous chrome field
joins the document band to the right dock, and warm paper is the brightest
field. One black ink keeps reading consistent across those surfaces. Jade
appears only where the writer acts; cinnabar is a scarce seal.

- **Audience:** fiction writers managing long-running serials, chapters, continuity notes, and agent-assisted revision threads.
- **Mood:** quiet shelf, warm chrome, lit paper.
- **Density:** comfortable reading/drafting rhythm in the main column; compact but legible metadata in rails and rows.
- **Scope:** authenticated app shell, project views, chat/thread surfaces, context/document surfaces, and marketing-adjacent pages that share the brand language.

The shell has exactly three region materials. Their separation is tonal—through
lightness—not a seam border or structural shadow. Internal cards, fields, code
blocks, overlays, and the composer may still define local steps within a region.

## Color roles

Use semantic tokens from `@meridian/design-tokens/ink-jade.css`, never literals:

- `shelf` / `shelf-active` — the rail, chrome's grey-gold one shade darker `oklch(0.91 0.012 84)`, and its pressed step `oklch(0.86 0.014 84)`.
- `sidebar` — grey-gold chrome `oklch(0.945 0.012 84)`, shared pixel-identically by the tab band and dock.
- `background` — warm paper `oklch(0.977 0.007 95)`, always the brightest shell field.
- `foreground` — the one black ink, `oklch(0.24 0.009 100)`, for primary text throughout light mode.
- `primary` / `jade-text` — jade for actions, links, focus, send, and save; never a wall or routine selection.
- `cinnabar` — scarce seal punctuation for brand and rare favorite/pin semantics; never routine actions or active rows.
- `card` / `muted` — local raised and recessed steps inside a region.
- `border` / `border-subtle` / `border-focus` — in-pane controls and hairlines, never shell-region seams.
- `prose-foreground` / `ink-muted` / `ink-subtle` — editorial hierarchy inside dense UI and prose-adjacent surfaces.
- `composer-surface` / `composer-border` — the manuscript tone plus a border; the composer does not borrow the chrome or action color.

Contrast is part of the palette contract: standard ink measures about 12.6:1 on
the flat shelf and 10.7:1 on its pressed step; muted and hint tiers measure 6.5:1.
See the [Earthen Value Ladder decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/earthen-value-ladder-shell.md)
for rationale, measurements, and rejected directions rather than duplicating
them here.

## Shell shape and atmosphere

- The shelf uses `shelf-surface` so its local surface, hairline, muted, hint, error, and focus roles remain legible without component forks.
- The document band and dock are one continuous chrome field. The dock uses `dock-surface`; Chat and Changes are quiet pressed pills, not tabs.
- The page rises from chrome with the same top radius as its active document tab. Region separation stays tonal: no seam border or structural shadow.
- Quiet floor atmosphere may deepen the shelf and lift the dock without creating a fourth shell material.
- Dark mode is not active. Its ladder must be designed as a whole-app slice rather than accumulated through partial overrides.

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
