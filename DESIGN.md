---
version: alpha
name: Earthen Value Ladder
summary: Meridian Flow writing project UI — one warm-grey chrome, a white page, near-black ink, ink-overlay states, jade actions, and scarce cinnabar seals.
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

The writer workspace is black, white and one warm grey, so the manuscript
remains the visual center. One warm-grey chrome is the sidebar and the
bands over the pages, and the white page is the brightest field. One near-black ink
keeps reading consistent across those surfaces. Jade appears only where the
writer acts; cinnabar is a scarce seal.

- **Audience:** fiction writers managing long-running serials, chapters, continuity notes, and agent-assisted revision threads.
- **Mood:** warm-grey panels around a white page.
- **Density:** comfortable reading/drafting rhythm in the main column; compact but legible metadata in rails and rows.
- **Scope:** authenticated app shell, project views, chat/thread surfaces, context/document surfaces, and marketing-adjacent pages that share the brand language.

The shell has at most two region tones: chrome for the sidebar, the tab band and the
side's header, and page for the main view and the side's document or chat. The two sit close
together, so each page is a sheet set into the chrome with a hairline on its top and sides; no line runs
the height of the window between a side panel and the centre. Cards, menus and the composer are
white like the page and separate by border and shadow, and a review ground one step
below chrome sits under draft chrome only while a draft is under review.

## Color roles

Use semantic tokens from `@meridian/design-tokens/ink-jade.css`, never literals:

- `chrome` — warm grey `oklch(0.962 0.006 60)`: the sidebar, main's tab band and the side's band.
- `background` — white, the page.
- `card` — white: cards, menus, popovers, the composer, bubbles; border and shadow lift them.
- `review` — one step below chrome `oklch(0.938 0.008 60)`, under draft chrome and the reviewing tab.

Every neutral (surfaces and both inks) is hue 60 at chroma 0.006 or less; the review ground takes 0.008. Hues toward
yellow-green (85–140) read olive at that chroma; keep neutrals off them.
- `foreground` / `muted-foreground` — the two inks. A hint differs by size, never by a paler ink.
- `ink-fill` / `ink-fill-strong` — foreground at 5% and 10%: hover and wells, then current, selected, open and pressed. Filled controls take them through the `interactive` layer.
- `border` / `border-subtle` — foreground at 15% and 9%, for hairlines. They are translucent: two that overlap darken.
- `page-edge` — `border-subtle` resolved onto the page, opaque, for the page sheet's edge and its folder tab's outline, whose strokes meet.
- `focus` — the one keyboard focus colour, 3:1 or better on every surface.
- `primary` / `jade-text` — jade fills and icons, and jade text; never a wall or routine selection.
- `cinnabar` — the brand seal.

Contrast is part of the palette contract: every text ink (`foreground`,
`muted-foreground`, `jade-text`, `destructive`, `warning-ink`) holds 4.5:1 on every
surface, plain and under both overlays, in both themes; the tightest is `muted-foreground`
in a current row on `review`, about 4.7:1. Accents stay inside sRGB at their lightness, or
the browser clips them to a duller hue.
See the [design language foundations](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/design-language-foundations.md)
for rationale, measurements, and rejected directions rather than duplicating
them here.

## Shell shape and atmosphere

- The sidebar and the two bands are one chrome. The side shows one document or chat on its own `page-sheet` below its band, inset 8px from main's (owner, 2026-11-12: the draft ground must sit on a page, not on chrome), never tabs or a view switch. Only a `page-sheet` paints page; the editor takes its host's surface.
- Both bands are one `tab-band` of one height (`--band-height`, 44px under a finger), whatever they hold, so main's page and the side's start level.
- The page rises from chrome with the same top radius as its active document tab. The centered chat header's title chip is the same tab-chip grammar — the chat page continuing up into the band. The page is a sheet with a `page-edge` hairline on its top and sides and rounded top corners; the active tab is a folder tab whose outline is one shape, flaring outward into the sheet's edge. No structural shadow.
- Dark mode re-points surfaces, inks and accents only (`themes.css`); state fills and borders follow the foreground.
- Headings, group labels, rows, hints, empty lines and fills come from `role` (`apps/app/src/components/ui/roles.ts`).

## Typography

One font everywhere in the app — **Inter** — loaded via Google Fonts in the app
root layout:

| Role | Font | Use |
|---|---|---|
| Everything | Inter | UI chrome, manuscript editor, rendered markdown, conversation turns, headings, login |

Four text sizes, each with one job:

| Size | Token | Use |
|---|---|---|
| 12px | `text-xs` | labels, group labels, counts, chips, timestamps, the word count |
| 13px | `text-sm` | every control and row: sidebar rows, menus, pickers, buttons, headers |
| 14px | chat prose | chat messages, their tables and the composer |
| 16px | document prose | the manuscript and every document |

Emphasis inside the chrome comes from weight, never from a third UI size.

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
  The ring is `focus-ring`, and it draws inside the control's own box, so no scroller,
  rounded card or filled neighbour can cut it and no site leaves it room. The exception
  is `focus-ring-outside`, for a control with no room inside: inline text (a link, a
  text button, a link chip) or a small control filled in the focus colour (a checked
  switch). Over a sticky or pinned bar, give the scroller `scroll-padding`.
- An icon-only control is `IconButton`. Its required `label` is both its accessible
  name and its tooltip. Its `size` sets the glyph too: `xs` is a 24px box with a 14px glyph,
  `sm` a 32px box with a 16px glyph, so a call site never sizes the glyph. A menu or popover
  trigger wraps it (`asChild`). Under a coarse pointer it and `Button` grow to the 44px touch
  target themselves (the `coarse:` variant), so a call site never adds touch sizing.
- A search box is `SearchField` (`SettledSearchField` when typing must not re-render the list it
  filters); a picker's is `PickerSearch`.
- The name above a list or a group of its rows is `ListSection` (or `ListSectionHeader`
  over a pane's own scroller): the uppercase group label on the rows' text edge, actions
  shown on hover, and, when it folds, a `FoldToggle` whose chevron leads the label. A list section's fold is remembered per tab with
  `useSectionFold`; the docked Scratch keeps its open state as a device preference.
- A list's rows are `ListRow`. In the sidebar and page lists a row's kind is its `icon`,
  one slot and one glyph size; pickers keep their 16 px glyphs in `leading`. The line that stands in for the rows (loading, empty, no matches) is
  `ListLine`, placed where the rows go, so its text starts where theirs would. A search
  that finds nothing says "No {things} match “{query}”." in the list's own noun.
  A row's actions are its `menu`: the right-click menu and a ⋯ named "Actions for {title}",
  small enough that rows with and without one are the same height. Selected rows that touch
  join into one block (`data-selection-run`). A name edited in place sits in `ListRowField`,
  where the title was, so the words don't move.
- Anything that folds is a `FoldToggle`: its `DisclosureMark` chevron leads the label
  (pointing right, turning down when open), there is no hover fill, and hover darkens the
  label. It is a row's 28 px height, or `inline` in a line of text. Rows beside a fold that
  doesn't fold keep the chevron's slot where they must line up (subagent rows). A control
  that opens a choice of values wears `ChooserMark`. One glyph and size each, from
  `components/ui/marks`.
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
- Pending changes are settled with `ReviewActions` (`features/draft-review`): Discard
  in quiet ink, then Apply as the filled jade button, as words or as ×/✓. Discard is
  never red and never a trash icon; those mean Delete. One name per scope: Apply and
  Discard for a change, Apply draft and Discard draft for a document, Apply all and
  Discard all for everything. A document's pair shows the bare verb, since the Draft chip
  beside it names the scope; the full name is its tooltip and accessible name.
- What a command did, with its Undo, is a line where it happened: `ActionNotice`
  ("Deleted Chapter 3 · Undo · ×"), quiet `text-xs`, staying until the next action or
  Dismiss. An Undo that failed takes its place as `InlineErrorRow`.
- An error is a line: `InlineErrorRow`, a red icon with body-ink text and at most one
  text action. A floating editor message is `EditorNoticePill`; a standing note above a
  document is `DocumentNotice`. None of them push content down when they appear.
- Respect reduced motion; motion should clarify location or state, not perform for its own sake.
- Show model/thread/process depth only when it helps the writer understand or recover from a situation.

## Implementation rules

- Shared visual decisions go in `@meridian/design-tokens/ink-jade.css` or app-level CSS utilities.
- Components consume semantic classes/vars, not literal colors.
- Feature surfaces should compose existing UI primitives before adding new ones.
- App code should preserve the product language: projects, works, chapters, context, threads, agents, turns.
- Infrastructure language belongs in debug/admin surfaces, not primary writing flows.
