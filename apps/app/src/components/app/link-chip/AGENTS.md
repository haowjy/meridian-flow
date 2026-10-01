# components/app/link-chip — the one look for links

How a link looks in every surface that shows one: internal links as a tag chip
(soft fill, family icon, name; dashed when nothing is at that address),
external links as underlined text with an outbound arrow. What a link *means*
and which state it is in is [`core/editor/links/`](../../../core/editor/links/AGENTS.md);
this directory only draws.

## Mental model

Three pieces, one owner each:

- **Which chip** is `linkChip()` / `referenceChip()` in
  `core/editor/links/link-chip.ts`: pure rules from target and resolution
  answer to `{ state: filled | dashed, icon: family }`. A surface spreads
  `linkChipAttributes()` onto the element and does nothing else.
- **The look** is `link-chip.css`, keyed by `data-link-chip` and
  `data-link-chip-icon`, imported once by `styles/globals.css`. Unlayered, so
  it beats `.prose-tokens a` wherever a chip is an anchor in prose. A chip has
  two forms: the element carrying the attributes (transcript, composer), or an
  `<a>` whose descendants carry `data-link-chip-part` (the Editor, where the
  link mark is one `<a>` around a label its decorations split per text node).
  Every rule names both.
- **The icons** are `family-icons.ts`: lucide `IconNode` data held once.
  `schemeIcon()` (sidebar, menus, identity bar) builds React components from
  it, and `LINK_CHIP_ICON_CSS` derives one mask-image rule per family, which
  the root route writes into the document head.

The icon is a CSS mask on `::before`, never a React icon, because the Editor
cannot mount React inside marked prose; a mask keeps every surface
pixel-identical and keeps the icon out of copies and accessible names. The
`::before` is an empty inline box sized by padding, not an inline-block: an
atomic inline is a line-break opportunity, and the icon would end one line
with the name starting the next.

Core names families and never imports icons (`core` must not import
`features/` or `components/`); the family-to-image map exists only here.

The fill follows the surface through `--link-chip-fill` and
`--link-chip-fill-hover` (default: the recess and one step deeper). The dock,
whose own tone is the recess, re-points them in `dock-surface`; raised
page-toned surfaces inside it (`bg-chat-interactive`, `composer-input`) point
them back. A new surface whose tone is the recess does the same.

## Key rules

- **No surface restyles a chip.** A local class on a chip is a second look.
  Change `link-chip.css`, and every surface changes together.
- **Dashed means nothing is at that address.** Asking and failed draw
  filled; a guess that corrects itself is worse than waiting. The dashed
  border carries the quietness, never the ink: a dashed name stays at 4.5:1
  on every surface (`--color-muted-foreground`).
- **A new family is a new scheme in contracts plus a node here.** The
  `Record<LinkChipIcon, …>` makes a missing image a type error.
- **Hover is for chips that go somewhere.** A transcript or composer chip
  goes somewhere when it is an enabled `role="link"`; an Editor chip always
  does (a plain click follows it), so the anchor form (`a:has(...)`) hovers
  on its own. Do not make Editor hover depend on a role on the `<a>`. Skills
  (`/slug` atoms) are not document links and keep their own underline.

→ [Internal Links Are Link Chips][link-chips] (KB): the owner decision, the
  states, and the rejected looks

[link-chips]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/link-chips.md
