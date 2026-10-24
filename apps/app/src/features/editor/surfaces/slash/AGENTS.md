# surfaces/slash — the menu `/` opens

The insertion menu: two groups while the writer is browsing, a
best-match list the moment they type, ~8 rows visible with the rest behind an
internal scroll. It renders the open menu, and owns the manuscript's own list
of rows in writer copy (`slash-catalog-copy.ts`, handed to the extension by
the host with its file picker). Where `/` may open, what an entry does to the
document, and which keys the menu owns all live in
[`core/editor/extensions/slash/`](../../../../core/editor/extensions/slash/AGENTS.md).

## Mental model

Rows, and nothing else. The writer never leaves the sentence — focus stays in
the prose, the query is the document text after the `/`, the arrow keys belong
to the trigger — and every bit of that is
[`chrome/SuggestionMenu`](../../chrome/SuggestionMenu.tsx), which the `@` menu
shares. This file answers two questions: what a row says, and when a group
heading opens above one.

## Key rules

- **A menu with no rows does not exist** ([offer only what applies][offer]).
  When the filter matches nothing the store reports closed, so Enter splits the
  paragraph as it would with no menu on screen, and backspacing brings the list
  back.
- **Every row applies wherever the menu opens**, so there is nothing to grey.
  Availability is the schema's answer in core, so the menu in a table cell is
  the same menu as in a paragraph — identical rows, identical order. The shared
  surface's greyed-row machinery belongs to other menus.
- **Group headings only with an empty query.** Filtered matches sort by score,
  so headings over them would fragment.
- **Icons come from the toolbar's family** (lucide), keyed by catalog id in
  `slash-menu-icons.tsx`. They are not copy and do not belong in the host's
  catalog; every writer-facing string in the menu does.

## Anti-patterns

- Reading `editor.state` for what the menu should show. The store is the seam;
  it is already the trigger's answer.
- Re-implementing the scroll, the fades, or the announcement here. They live in
  the shared surface so the two typed-under menus cannot drift apart.

→ [`../../AGENTS.md`](../../AGENTS.md)
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) for the wrappers and the layer contract

[offer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/offer-only-what-applies.md
