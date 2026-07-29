# surfaces/slash — the menu `/` opens

The insertion menu from §5.7: two groups while the writer is browsing, a
best-match list the moment they type, ~8 rows visible with the rest behind an
internal scroll. It renders the open menu and nothing else — where `/` may
open, what an entry does to the document, and which keys the menu owns all
live in [`core/editor/extensions/slash/`](../../../../core/editor/extensions/slash/AGENTS.md).

## Mental model

The writer never leaves the sentence. The query is the document text after the
`/`, the caret stays in the prose, and this surface is a read-only view of what
the trigger already matched. Everything else follows from that:

- `focusOnOpen="prose"` on `EditorPopover`, and every row cancels its own
  mousedown. A row that took focus would end the filter mid-word.
- The keyboard is the trigger's, registered at the kernel's `layer` scope while
  the menu is open. This file follows the highlight with the scroll; it does not
  bind a key.
- Escape is the kernel's chain, reached by being an open layer — free from the
  wrapper.

## Key rules

- **A menu with no rows does not exist** (law 5). When the filter matches
  nothing the store reports closed, so Enter splits the paragraph the way it
  would with no menu on screen, and backspacing brings the list back.
- **Group headings only with an empty query.** Filtered matches sort by score,
  so headings over them would fragment; mockup 07's state B drops them too.
- **Icons come from the toolbar's family** (lucide), keyed by catalog id in
  `slash-menu-icons.tsx`. They are not copy and do not belong in the host's
  catalog; every writer-facing string in the menu does.
- **Measure the scroller from its ref callback, not an effect.** Radix mounts
  the portal's children a commit after `open` flips, so an effect keyed on
  `open` runs with nothing to measure and the fades never appear.
- The height cap, the hidden scrollbar, and the fades live in `editor.css`
  under the L-D banner. No raw color anywhere.

## Anti-patterns

- Reading `editor.state` for what the menu should show. The store is the seam;
  it is already the trigger's answer.
- Binding arrow keys or Enter here. A React effect registers them after the
  first keystroke a fast writer sends.
- Anchoring to a captured point. The `/` moves when the manuscript scrolls;
  `anchorRect` is read on every reposition for exactly that reason.

→ [`../../AGENTS.md`](../../AGENTS.md)
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) for the wrappers and the layer contract
→ design of record: `editor-toolbar-split/interaction-model.md` §5.7, mockup 07
