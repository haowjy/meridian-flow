# core/completion — the headless half of a menu the writer types underneath

The open-menu store every trigger publishes through, plus the canonical
reference policy and hierarchical browser over the normalized context catalog.
Hosts drive it through the editor's lane mechanism
([`../editor/extensions/suggestion/`](../editor/extensions/suggestion/suggestion-lane.ts))
and the shared Composer. Neither host is visible from here.

## Mental model

**Nothing here knows what is rendering it.** No ProseMirror, no DOM, no React,
no writer-facing string. `anchorRect` is the single piece of geometry a menu
carries and the host supplies it as a callback, so the same store serves a
ProseMirror rect and a caret-mirror measurement without learning which it got.
The placement argument, drawn from the real dependency graph, is the module
header in [`index.ts`](index.ts).

**A trigger owns its envelope; this owns the menu.** Where a trigger may open,
what a choice writes, and how a row looks all belong to the host. What arrives here is a driver frame: trigger text, query, range, candidates,
geometry, and the transport's exit request. One `SuggestionDriver` owns the
session and generation behind the private lifecycle, so stale updates or closes
are refused rather than published by arrival order.
Query/context/container updates reset selection by explicit caller policy, while
a same-session refresh can preserve the active stable row ID. The store's own
judgment remains narrow — a menu is open only while it has rows, the highlight
sits on the first row the host will accept, and a row the host refuses is stepped
over rather than handed a key that does nothing.

**Transitions are serialized events.** An accepted open, update, or close first
installs its captured snapshot, then calls its lifecycle callback, then notifies
menu subscribers. A synchronous reentrant transition waits in the lifecycle's
FIFO until that event is complete, while still returning its reserved identity
or acceptance immediately. Close consumes the full session/generation ticket;
session ID alone never proves ownership.

**Interactions describe actions, not host policy.** One `SuggestionHost` lease
registers ordinary ArrowUp, ArrowDown, Home, End, Enter, and Tab bindings plus
semantic retreat (`backtrack`, then root `dismiss`). The shared menu owns edge
movement and Enter-versus-Tab choice intent, while each host places retreat in
its own Escape precedence. Releasing the lease tears down both halves once.

**The browser projects; the catalog owns metadata.** `ReferenceCatalogPort`
reads the one F1 `CatalogCacheView` and delegates explicit cold-Work acquisition
to its owner. The browser never stores a second tree, enumerates availability,
or turns wake hints into rows. Root merges only project, user, and current Work
or no-Work warm views. Other Works remain authority rows until activated.

**Lexical tiers are inviolable.** Exact, prefix, word-start, contains, and fuzzy
matches are strict tiers. Open-document and contextual priors break ties only
inside a tier; normalized F1 tree order is last. Stable document identity is
deduplicated and the 20-row cap applies only after the merged ordering.

**Terminal identity is already authoritative.** A file row contains one
`AuthoritativeReference`: document ID, persisted file classification, label,
stable authority, and full non-contextual URI. Work and no-Work contextual URI
syntax is verified through the contracts parser at this boundary; contextual
Work syntax is never reconstructed into stable identity on the client.

**Ambiguity is shown, not resolved.** Two documents with one title resolve to
nothing, so a row whose name is shared says so and is still offered. Renaming one
of them is the writer's fix, and the menu never guesses which they meant.

## Key rules

- **No import from `editor/`, `features/`, or a rendering library.** A completion
  that needs the editor belongs in the editor's lane, not here. The reverse
  direction is fine and expected.
- **Host callbacks, never host state.** Driver `start`/`update`/`exit`, row
  `choose`, `dismiss`, segment completion, terminal selection, and `anchorRect`
  are read live. F2 performs no React rendering or document insertion.
- **A withdrawn session closes rather than freezes.** Hosts can lose their
  catalog mid-menu (a schema fence, a read-only surface), and `close()` is the
  one door for it.
- **Navigation is semantic.** Enter drills or selects. Tab selects a terminal;
  on a navigation row it completes one canonical URI segment and drills without
  closing. Retreat backtracks one level before the host dismisses at root.
- **No reference create row.** Bare `@` is a trigger, never a reference.

## Anti-patterns

- Growing the snapshot with something only one surface renders. That is `TMeta`,
  or it is the host's own state.
- A second title-matching rule anywhere. Two ranking implementations is two
  menus that disagree about one query, and one of them disagrees with the
  resolver.
- Reading availability lookup or cold wake hints as browse candidates.
- Fetching recursively or retaining catalog entries in the browser controller.

`wikilink-catalog.ts` remains temporarily because the existing `[[` host still
imports it. F6 migrates that host; D then deletes the file and its legacy
ranker. Do not add another caller or a compatibility export around it.

→ [`../editor/extensions/suggestion/`](../editor/extensions/suggestion/suggestion-lane.ts) —
  the TipTap adapter that drives this from a lane spec
→ [`../editor/extensions/wikilink/AGENTS.md`](../editor/extensions/wikilink/AGENTS.md) —
  what `[[` does with a chosen row
