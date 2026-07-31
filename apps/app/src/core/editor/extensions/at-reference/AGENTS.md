# extensions/at-reference — the `@` trigger

Three small modules and a spec: where `@` may open
([`at-trigger.ts`](at-trigger.ts)), what it may offer
([`at-reference-catalog.ts`](at-reference-catalog.ts)), what a choice writes
([`at-reference-insertion.ts`](at-reference-insertion.ts)), and the lane spec
that hands all three to the shared mechanism
([`AtReferenceExtension.ts`](AtReferenceExtension.ts)). How rows rank is
[`@/core/references`](../../../references/AGENTS.md); the open menu React reads
is [`@/core/completion`](../../../completion/AGENTS.md). The surface that
renders it is
[`features/editor/surfaces/link/`](../../../../features/editor/surfaces/link/AGENTS.md).

## Mental model

**One primitive, two doors.** `@` deliberately overlaps `[[` on documents, and
a document picked here becomes the same link mark `[[` writes — same text, same
href, byte for byte — except an ambiguous title, where the shared spelling
policy (`core/references`) keeps the title as the text and carries the pick's
canonical URI as the href, because the resolver refuses a name two documents
answer to. It is not a second reference construct; it is the same one reached
by writers with a different habit, and the habit generalizes: an asset picked
here becomes the inline `image` node the upload path lands. Phase 1 adds no
wire spelling.

**`@` is prose until it is a request.** Two brackets are already unambiguous; a
lone `@` is a preposition, half an address, and a handle someone is quoting. So
this lane adds two refusals to the shared envelope, and both are about telling
those apart:

- **The word boundary** (`/`'s own rule, shared): an `@` typed against a letter
  is inside a word, which is where every email address keeps its own.
- **A query that opens with a space is not a name**: "meet @ noon" sits at a
  legal trigger position — the space before it is exactly what makes it legal —
  so the space AFTER it is what leaves the writer alone with their sentence.

## Key rules

- **`allowSpaces` is on, and has to be.** Document titles have spaces; a menu
  that stopped at "The Second" could not find "The Second Gate".
- **No auto-paired closer is swallowed.** `[[` consumes the `]]` its own second
  bracket wrote; `@` opens no pair, so a `)` or `"` past the caret belongs to
  an opener the writer typed and stays where it is.
- **The prose can hold a picture, not a PDF.** The catalog carries every asset
  (the composer's `@` will name any of them as text); this lane withholds the
  ones it would have no object to insert.
- **No create row for a picture** — you cannot conjure an image from a name.
  That is the engine's rule, from the scope this lane asks with; the document
  create row behaves exactly as `[[`'s ("links now, page later").
- **The catalog is the host's**, read at open, and null withdraws the trigger.
  It carries the menu's copy too: its name, and the heading each kind sits
  under.

## Anti-patterns

- Writing a document reference any way but the wikilink lane's insertion
  (`insertDocumentReference` for a catalog row, `insertWikilink` for a bare
  name). A second spelling of one meaning is two things every consumer must
  treat as one, forever — and a branch on `ambiguous` in this lane is that
  drift starting: which shape a row gets is `referenceLinkSpelling`'s call.
- Inserting the `figure` node for an asset. The inline `image` is the object
  §5.6 settled; `figure` is a different dialect contract.
- A kind-specific ranking rule here or in the engine. Kinds differ in what a
  row carries, not in how a name matches.

→ [`../suggestion/suggestion-lane.ts`](../suggestion/suggestion-lane.ts) — the
  mechanism every lane shares
→ [`../suggestion/trigger-envelope.ts`](../suggestion/trigger-envelope.ts) —
  where a trigger may open at all
→ [`../wikilink/AGENTS.md`](../wikilink/AGENTS.md) — the other door, and the
  insertion both use
→ [`../../images/AGENTS.md`](../../images/AGENTS.md) — `insertInlineImage`, the
  slot a picture takes
→ [`../../../references/AGENTS.md`](../../../references/AGENTS.md) — what the
  rows are and how they rank
→ design of record: `editor-toolbar-split/design-at-references.md`
