# extensions/wikilink — the `[[` trigger

One small module and a spec: what a choice writes into the document
([`wikilink-insertion.ts`](wikilink-insertion.ts)), and the lane spec that hands
it, the shared envelope, and a scope to the shared mechanism
([`WikilinkSuggestionExtension.ts`](WikilinkSuggestionExtension.ts)). What the
menu may offer and how it ranks is
[`@/core/references`](../../../references/AGENTS.md); the open menu React reads
is [`@/core/completion`](../../../completion/AGENTS.md). The composer shares
both. Where the trigger may open is
[`../suggestion/trigger-envelope.ts`](../suggestion/trigger-envelope.ts), which
`@` reads too.
The surface that renders it is
[`features/editor/surfaces/link/`](../../../../features/editor/surfaces/link/AGENTS.md).

## Mental model

**This lane is a spec, not a plugin.** Storage, the `@tiptap/suggestion`
lifecycle, the arrow keys, the catalog fence, and dismissal live once in
[`../suggestion/suggestion-lane.ts`](../suggestion/suggestion-lane.ts). What this
directory declares is only what makes `[[` itself: the two characters, spaces
allowed, the scope it asks the catalog with, and the insertion. A behavior that
should hold for `/` and `@` too belongs in the mechanism or the shared envelope,
not here — and a change here that needs a new field on the spec is telling you
the same thing.

**Its envelope is the reference envelope, with nothing added.** `allowsProseTrigger`
is the whole rule: prose only, never a code fence, never inside a link the writer
is correcting. Unlike `/` and `@`, `[[` demands no word boundary — two brackets
are already an unambiguous request, and a wikilink legitimately follows an
opening quote with nothing between.

**A wikilink is a link, not a node.** What lands in the document is a link mark
whose href is `[[Name]]` and whose text is `Name` — the shape the codec spells
back as `[[Name]]`. Change either half and the wire format quietly becomes
`[text]([[Name]])`, which is not a wikilink at all. `insertWikilink` asks
`normalizeLinkHref` rather than assembling brackets, so this lane can never
disagree with the classifier about what a name means.

## Key rules

- **`allowSpaces` is on, and has to be.** Titles have spaces; a trigger that
  stopped at the first one could not find "The Second Gate". The cost is that the
  match runs to the end of the text node, which is why this lane refuses a query
  carrying `]` or `|` before it asks the catalog — a writer who closed their own
  brackets is left alone with their own text. That guard lives here, not in the
  catalog: it is a fact about how `[[…]]` is spelled, and `@` spells nothing.
- **The brackets after the caret are already there.** Auto-pairing writes `]]`
  when the writer types the second `[`, so the trigger opens inside `[[]]` and
  the range a choice replaces has to reach past them — `autoClosedRunLength` is
  how the spec's `choose` asks. A link inserted over the trigger's own range
  alone would leave `]]` stranded behind it.
- **What a choice writes is shared with `@`.** `insertWikilink` is exported for
  it, because a document referenced through either door has to land byte for
  byte the same. The one-shape rule is why: display = title, href = `[[Title]]`,
  and anything else round-trips as `[text]([[Name]])`, which is not a wikilink.
- **The create row inserts a link, never a document** (mockup 06 state D).
  "Links now, page later" is the whole point: serial writers link chapters
  before they write them.
- **The catalog is the host's**, read at open, and null withdraws the trigger. A
  read-only surface or a fenced document therefore pays for no menu. It carries
  every reference in scope, images included; `scope: ["document"]` is what makes
  this the document menu, because an image has no title the resolver can match.

## Anti-patterns

- Spelling `[[` + name + `]]` anywhere but through the link classifier.
- Reimplementing any part of the suggestion lifecycle here. Keymap timing,
  catalog withdrawal, and dismissal were duplicated across two lanes once
  already; the third copy is what this shape exists to prevent.
- Ranking or filtering rows here. That is `@/core/references`, so the composer
  and the editor agree about one query.

→ [`../suggestion/suggestion-lane.ts`](../suggestion/suggestion-lane.ts) — the
  mechanism every lane shares
→ [`../at-reference/AGENTS.md`](../at-reference/AGENTS.md) — `@`, the other door
  onto the same link
→ [`../../../references/AGENTS.md`](../../../references/AGENTS.md) — what the rows
  are and how they rank
→ [`../../../completion/AGENTS.md`](../../../completion/AGENTS.md) — the open menu
  the rows are published through
→ [`../auto-pair/AGENTS.md`](../auto-pair/AGENTS.md) — who wrote the `]]`
→ [`../../links/AGENTS.md`](../../links/AGENTS.md) — what a link means once it exists
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) for the layer, keymap, and Esc contracts
→ design of record: `editor-toolbar-split/interaction-model.md` §5.5, mockup 06
