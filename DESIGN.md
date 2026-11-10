---
version: alpha
name: Earthen Value Ladder
summary: Meridian Flow writing project UI — one grey-gold chrome, warm paper, black ink, ink-overlay states, jade actions, and scarce cinnabar seals.
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
remains the visual center. One warm grey-gold chrome is the sidebar, the
document band and the dock, and warm paper is the brightest field. One black ink
keeps reading consistent across those surfaces. Jade appears only where the
writer acts; cinnabar is a scarce seal.

- **Audience:** fiction writers managing long-running serials, chapters, continuity notes, and agent-assisted revision threads.
- **Mood:** paper grey panels around near-white warm paper.
- **Density:** comfortable reading/drafting rhythm in the main column; compact but legible metadata in rails and rows.
- **Scope:** authenticated app shell, project views, chat/thread surfaces, context/document surfaces, and marketing-adjacent pages that share the brand language.

The shell has at most two region tones: chrome for both side panels (the sidebar and the
dock) and the tab band, and page for the main view. The two sit close together, so a
hairline separates each side panel from the centre. The raised step serves cards, menus
and the composer, and a jade-grey review ground sits under draft chrome only while a
draft is under review.

## Color roles

Use semantic tokens from `@meridian/design-tokens/ink-jade.css`, never literals:

- `chrome` — paper grey `oklch(0.963 0.0055 85)`: the sidebar, the tab band and the dock.
- `background` — warm near-white paper `oklch(0.988 0.0045 90)`, the page.
- `card` — the raised step `oklch(0.996 0.003 90)`: cards, menus, popovers, the composer, bubbles.
- `review` — chrome with a little jade, under draft chrome and the reviewing tab.
- `foreground` / `muted-foreground` — the two inks. A hint differs by size, never by a paler ink.
- `ink-fill` / `ink-fill-strong` — foreground at 5% and 10%: hover and wells, then current, selected, open and pressed. Filled controls take them through the `interactive` layer.
- `border` / `border-subtle` — foreground at 15% and 9%, for hairlines, including the seam between each side panel and the centre.
- `focus` — the one keyboard focus colour, 3:1 or better on every surface.
- `primary` / `jade-text` — jade fills and icons, and jade text; never a wall or routine selection.
- `cinnabar` — the brand seal. `gold` — favourites only.

Contrast is part of the palette contract: `muted-foreground` holds AA in a current
row (10%) on the darkest surface in both themes.
See the [Earthen Value Ladder decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/earthen-value-ladder-shell.md)
for rationale, measurements, and rejected directions rather than duplicating
them here.

## Shell shape and atmosphere

- The sidebar, the document band and the dock are one chrome. The dock uses `dock-surface`. It shows one document or its native occupant, never tabs or a view switch.
- The page rises from chrome with the same top radius as its active document tab. The centered chat header's title chip is the same tab-chip grammar — the chat page continuing up into the band. Region separation stays tonal: no seam border or structural shadow.
- Quiet floor atmosphere may lift the dock without creating another shell material.
- Dark mode re-points surfaces, inks and accents only (`themes.css`); state fills and borders follow the foreground.
- Headings, group labels, rows, hints, empty lines and fills come from `role` (`apps/app/src/components/ui/roles.ts`).

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

The landing page (`apps/www`) is a deliberate, isolated branding exception. It
self-hosts IM Fell French Canon for titles, IM Fell Double Pica for story text and
Hanken Grotesk for plain text. Its UI colours are the normal roles (night regions set
`data-ui-theme="dark"`); only the sky and its scrims have their own tokens, in
`packages/design-tokens/src/marketing.css` and `marketing-sky.ts`.

## Login

Branded split hero (deep ink ground, needle mark, Inter wordmark, corner seal chop). Credentials and account creation are **WorkOS AuthKit hosted sign-in** — the right card hands off to WorkOS; Meridian owns visual identity, not the auth form. With `DEV_AUTH_BYPASS=1` local development skips this screen.

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
- Editing text in place never moves or resizes it. Use `components/ui/inline-edit`
  (`InlineEditInput`, `InlineEditTextarea`): the field inherits the text's
  typography, has no padding or border, sizes to its text, and paints its edge
  with the `inline-edit-field` box-shadow bleed. Resting text wears
  `inline-edit-trigger`. Tab titles (chat, Work) rename inside their tab. Single-line
  edits share one protocol, `useInlineEdit`: Enter or blur commits, Escape or an
  empty or unchanged name cancels, and a failure stays open with its message.
  iOS focus zoom is suppressed globally (`lib/ios-focus-zoom`), so fields keep the
  text's size on phones too.
- Confirm/dismiss pairs sit at the right edge, dismiss first: Cancel, then the
  primary action (Save, Create, Delete). Inline edits anchored to text (the Work
  goal) instead left-align Cancel then Save directly under the field, so the
  dismiss lands where the edit trigger was.
- Respect reduced motion; motion should clarify location or state, not perform for its own sake.
- Show model/thread/process depth only when it helps the writer understand or recover from a situation.

## Implementation rules

- Shared visual decisions go in `@meridian/design-tokens/ink-jade.css` or app-level CSS utilities.
- Components consume semantic classes/vars, not literal colors.
- Feature surfaces should compose existing UI primitives before adding new ones.
- App code should preserve the product language: projects, works, chapters, context, threads, agents, turns.
- Infrastructure language belongs in debug/admin surfaces, not primary writing flows.
