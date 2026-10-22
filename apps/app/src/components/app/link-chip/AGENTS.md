# components/app/link-chip — shared link appearance

This directory draws the single internal/external link treatment. Link meaning,
classification, resolution, and follow policy belong to
[`core/editor/links`](../../../core/editor/links/AGENTS.md).

- Core supplies pure `linkChip()`/`referenceChip()` state. Surfaces spread
  `linkChipAttributes()` and do not invent chip variants.
- `link-chip.css` owns the data-attribute look and shared family icon data. The
  icon is a CSS mask so Editor prose needs no React mount and copies/accessibility
  names contain no decorative icon.
- Surface tone changes only through `--link-chip-fill` and
  `--link-chip-fill-hover`; a recess-toned surface remaps those variables.
- No surface restyles a chip. Dashed means no document is currently at the address, or the document named
  by the link is gone; it is not a separate meaning or a reason to add local
  styling. External links remain underlined text with an outbound arrow.
- A dashed (gone) chip is `aria-disabled` and does not answer hover. A chip still
  asking or that failed draws filled: a guess that corrects itself is worse than
  waiting. Dashed carries its quietness in the border, never the ink: a dashed
  name stays at 4.5:1 on every surface.
- Hover is for chips that go somewhere: an enabled `role="link"` in transcript or
  composer, and an Editor chip always unless it is gone. Do not make Editor hover
  depend on a role on the `<a>`.
- A new family is a new scheme in contracts plus a node here; the
  `Record<LinkChipIcon, …>` makes a missing image a type error. Core names
  families and never imports icons.
- Skill atoms (`/slug`) are not document links and keep their own underline.

Read the core link guide before changing chip rules or adding a family. The owner
decision and rejected looks are in [Internal Links Are Link Chips][link-chips].

[link-chips]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/link-chips.md

Icon family additions must update the shared core contract before this module.
