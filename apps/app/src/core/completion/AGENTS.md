# core/completion — the headless half of a menu the writer types underneath

The open-menu store every trigger publishes through. Two hosts drive it: the
editor's lane mechanism
([`../editor/extensions/suggestion/`](../editor/extensions/suggestion/suggestion-lane.ts))
and, next, the chat composer's textarea. Neither one is visible from here, and
neither is what a row means — that is
[`../references/`](../references/AGENTS.md).

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
menu is open only while it has rows, the highlight sits on the first row the host
will accept, and a row the host refuses is stepped over rather than handed a key
that does nothing.

**The rows are opaque.** `TItem` is whatever the host ranked; the store never
reads a field on one. That is what lets the slash menu's blocks and the
reference catalog's documents and assets share one machine.

## Key rules

- **No import from `editor/`, `features/`, or a rendering library.** A completion
  that needs the editor belongs in the editor's lane, not here. The reverse
  direction is fine and expected.
- **Host callbacks, never host state.** `choose`, `dismiss`, and `anchorRect` are
  read live; the store holds no copy of a document, a catalog, or a rect.
- **A withdrawn session closes rather than freezes.** Hosts can lose their
  catalog mid-menu (a schema fence, a read-only surface), and `close()` is the
  one door for it.

## Anti-patterns

- Growing the snapshot with something only one surface renders. That is `TMeta`,
  or it is the host's own state.
- Reading a row's shape. The moment this file knows what a document is, the
  slash menu is importing the reference catalog to open a block list.

→ [`../references/AGENTS.md`](../references/AGENTS.md) — what a reference row is
  and how it ranks
→ [`../editor/extensions/suggestion/`](../editor/extensions/suggestion/suggestion-lane.ts) —
  the TipTap adapter that drives this from a lane spec
→ [`../editor/extensions/wikilink/AGENTS.md`](../editor/extensions/wikilink/AGENTS.md) —
  what `[[` does with a chosen row
