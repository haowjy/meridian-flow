# core/completion — the headless half of a menu the writer types underneath

The open-menu store every trigger publishes through, and the catalog that ranks
the documents a `[[…]]` may name. Two hosts drive it: the editor's TipTap lanes
([`../editor/extensions/suggestion/`](../editor/extensions/suggestion/suggestion-lane.ts))
and, next, the chat composer's textarea. Neither one is visible from here.

## Mental model

**Nothing here knows what is rendering it.** No ProseMirror, no DOM, no React,
no writer-facing string. `anchorRect` is the single piece of geometry a menu
carries and the host supplies it as a callback, so the same store serves a
ProseMirror rect and a caret-mirror measurement without learning which it got.
The placement argument, drawn from the real dependency graph, is the module
header in [`index.ts`](index.ts).

**A trigger owns its envelope; this owns the menu.** Where a trigger may open,
what a choice writes, and how a row looks all belong to the host. What arrives
here is a session: rows, the query, a label, and the two callbacks that take a
choice or a dismissal. The store's own judgment is narrow and deliberate — a
menu is open only while it has rows, the highlight sits on the first row the
host will accept, and a row the host refuses is stepped over rather than
handed a key that does nothing.

**The catalog agrees with the resolver or it is wrong.** Rows rank titles and
aliases because that is what `POST …/links/resolve` matches on, and names are
normalized the way the server normalizes them. A second normalizer is how a
menu starts offering documents the resolver refuses.

## Key rules

- **No import from `editor/`, `features/`, or a rendering library.** A
  completion that needs the editor belongs in the editor's lane, not here. The
  reverse direction is fine and expected.
- **Host callbacks, never host state.** `choose`, `dismiss`, and `anchorRect`
  are read live; the store holds no copy of a document, a catalog, or a rect.
- **A withdrawn session closes rather than freezes.** Hosts can lose their
  catalog mid-menu (a schema fence, a read-only surface), and `close()` is the
  one door for it.

## Anti-patterns

- Growing the snapshot with something only one surface renders. That is `TMeta`,
  or it is the host's own state.
- Ranking documents anywhere else. Two ranking rules is two menus that disagree
  about the same query.

→ [`../editor/extensions/suggestion/`](../editor/extensions/suggestion/suggestion-lane.ts) —
  the TipTap adapter that drives this from a lane spec
→ [`../editor/extensions/wikilink/AGENTS.md`](../editor/extensions/wikilink/AGENTS.md) —
  what `[[` does with a chosen row
