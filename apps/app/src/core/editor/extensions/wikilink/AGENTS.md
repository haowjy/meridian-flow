# extensions/wikilink — the `[[` trigger

Three small modules and the plugin that wires them: where `[[` may open
(`wikilink-trigger.ts`), what the menu is offering (`wikilink-catalog.ts`), and
what a choice writes into the document (`wikilink-insertion.ts`). The open menu
React reads is the shared store in
[`../suggestion/`](../suggestion/suggestion-menu-store.ts); the surface that
renders it is
[`features/editor/surfaces/link/`](../../../../features/editor/surfaces/link/AGENTS.md).

## Mental model

**A wikilink is a link, not a node.** What lands in the document is a link mark
whose href is `[[Name]]` and whose text is `Name` — the shape the codec spells
back as `[[Name]]`. Change either half and the wire format quietly becomes
`[text]([[Name]])`, which is not a wikilink at all. `insertWikilink` asks
`normalizeLinkHref` rather than assembling brackets, so this lane can never
disagree with the classifier about what a name means.

**The menu offers what the resolver can find.** Rows rank titles and aliases
because that is what `POST …/links/resolve` matches on. A host that offers a
document the resolver has no candidate for hands the writer a link that lands
dashed the instant it is inserted; the host's job is to offer the manuscript
and the work's scratch, which is the resolver's own candidate set.

**Ambiguity is shown, not resolved.** Two documents with one title resolve to
nothing, so a row whose name is shared says so and still inserts. Renaming one
of them is the writer's fix, and the menu never guesses which they meant.

## Key rules

- **`allowSpaces` is on, and has to be.** Titles have spaces; a trigger that
  stopped at the first one could not find "The Second Gate". The cost is that
  the match runs to the end of the text node, which is why the catalog returns
  no rows for a query carrying `]` or `|` — a writer who closed their own
  brackets is left alone with their own text.
- **The brackets after the caret are already there.** Auto-pairing writes `]]`
  when the writer types the second `[`, so the trigger opens inside `[[]]` and
  the range a choice replaces has to reach past them —
  `autoClosedRunLength` is how it asks. A link inserted over the trigger's own
  range alone would leave `]]` stranded behind it.

- **The create row inserts a link, never a document** (mockup 06 state D).
  "Links now, page later" is the whole point: serial writers link chapters
  before they write them.
- **The catalog is the host's**, read at open, and null withdraws the trigger.
  A read-only surface or a fenced document therefore pays for no menu.
- **Keys register from the suggestion's `onStart`**, which is plugin-view
  lifetime. A React effect would arrive after the first ArrowDown of a writer
  who types `[[` and moves in one motion.

## Anti-patterns

- Spelling `[[` + name + `]]` anywhere but through the link classifier.
- A second title-matching rule. `filterWikilinkItems` normalizes names the way
  the server's resolver does; two normalizers is how a menu starts offering
  documents the resolver refuses.
- Creating a document from the create row. That belongs to the app's navigator,
  where the writer has actually asked to open the thing.

→ [`../auto-pair/AGENTS.md`](../auto-pair/AGENTS.md) — who wrote the `]]`
→ [`../../links/AGENTS.md`](../../links/AGENTS.md) — what a link means once it exists
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) for the layer, keymap, and Esc contracts
→ design of record: `editor-toolbar-split/interaction-model.md` §5.5, mockup 06
