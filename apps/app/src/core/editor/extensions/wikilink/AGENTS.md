# extensions/wikilink — the `[[` trigger

Two small modules and a spec: where `[[` may open
([`wikilink-trigger.ts`](wikilink-trigger.ts)), what a choice writes into the
document ([`wikilink-insertion.ts`](wikilink-insertion.ts)), and the lane spec
that hands both to the shared mechanism
([`WikilinkSuggestionExtension.ts`](WikilinkSuggestionExtension.ts)). What the
menu offers, how it ranks, and the open menu React reads are
[`@/core/completion`](../../../completion/AGENTS.md), which the composer shares.
The surface that renders it is
[`features/editor/surfaces/link/`](../../../../features/editor/surfaces/link/AGENTS.md).

## Mental model

**This lane is a spec, not a plugin.** Storage, the `@tiptap/suggestion`
lifecycle, the arrow keys, the catalog fence, and dismissal live once in
[`../suggestion/suggestion-lane.ts`](../suggestion/suggestion-lane.ts). What this
directory declares is only what makes `[[` itself: the two characters, spaces
allowed, the predicate, the catalog filter, and the insertion. A behavior that
should hold for `/` and `@` too belongs in the mechanism, not here — and a change
here that needs a new field on the spec is telling you the same thing.

**A wikilink is a link, not a node.** What lands in the document is a link mark
whose href is `[[Name]]` and whose text is `Name` — the shape the codec spells
back as `[[Name]]`. Change either half and the wire format quietly becomes
`[text]([[Name]])`, which is not a wikilink at all. `insertWikilink` asks
`normalizeLinkHref` rather than assembling brackets, so this lane can never
disagree with the classifier about what a name means.

## Key rules

- **`allowSpaces` is on, and has to be.** Titles have spaces; a trigger that
  stopped at the first one could not find "The Second Gate". The cost is that the
  match runs to the end of the text node, which is why the catalog returns no
  rows for a query carrying `]` or `|` — a writer who closed their own brackets
  is left alone with their own text.
- **The brackets after the caret are already there.** Auto-pairing writes `]]`
  when the writer types the second `[`, so the trigger opens inside `[[]]` and
  the range a choice replaces has to reach past them — `autoClosedRunLength` is
  how the spec's `choose` asks. A link inserted over the trigger's own range
  alone would leave `]]` stranded behind it.
- **The create row inserts a link, never a document** (mockup 06 state D).
  "Links now, page later" is the whole point: serial writers link chapters
  before they write them.
- **The catalog is the host's**, read at open, and null withdraws the trigger. A
  read-only surface or a fenced document therefore pays for no menu.

## Anti-patterns

- Spelling `[[` + name + `]]` anywhere but through the link classifier.
- Reimplementing any part of the suggestion lifecycle here. Keymap timing,
  catalog withdrawal, and dismissal were duplicated across two lanes once
  already; the third copy is what this shape exists to prevent.
- Ranking or filtering rows here. That is `@/core/completion`, so the composer
  and the editor agree about one query.

→ [`../suggestion/suggestion-lane.ts`](../suggestion/suggestion-lane.ts) — the
  mechanism every lane shares
→ [`../../../completion/AGENTS.md`](../../../completion/AGENTS.md) — what the rows
  are and how they rank
→ [`../auto-pair/AGENTS.md`](../auto-pair/AGENTS.md) — who wrote the `]]`
→ [`../../links/AGENTS.md`](../../links/AGENTS.md) — what a link means once it exists
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) for the layer, keymap, and Esc contracts
→ design of record: `editor-toolbar-split/interaction-model.md` §5.5, mockup 06
