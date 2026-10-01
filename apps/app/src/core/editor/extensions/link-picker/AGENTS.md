# extensions/link-picker — the `[[` trigger

Typing `[[` in prose opens a picker of the project's documents; choosing one
writes a **standard Markdown link** to its address. There are no wikilinks:
`[[name]]` typed, pasted, or written by the AI is plain text, and nothing here
converts it.

Four small modules: where `[[` may open
([`link-picker-trigger.ts`](link-picker-trigger.ts)), which rows a query offers
([`link-picker-items.ts`](link-picker-items.ts)), what a choice writes
([`document-link-insertion.ts`](document-link-insertion.ts)), and the lane spec
that hands them to the shared mechanism
([`LinkPickerExtension.ts`](LinkPickerExtension.ts)). The surface that renders
it is
[`features/editor/surfaces/link/`](../../../../features/editor/surfaces/link/AGENTS.md).

## Mental model

**This lane is a spec, not a plugin.** Storage, the `@tiptap/suggestion`
lifecycle, the arrow keys, the catalog fence, and dismissal live once in
[`../suggestion/suggestion-lane.ts`](../suggestion/suggestion-lane.ts). What this
directory declares is what makes `[[` itself: the two characters, spaces
allowed, the predicate, the rows, and the insertion.

**A choice is a link to an address.** The link's text is the document's name;
its href is `spellDocumentHref(holderUri, uri)` from `@meridian/contracts`:
relative within the holder's area (`chapter-2.md`, `../volume-1/chapter-1.md`),
a full Context URI across areas (`kb://characters/Lin Feng.md`), and always a
full URI from a holder with no address yet. `@` references in the Editor insert
through the same `insertDocumentLink`, so one destination is spelled one way.

**Rows say where a document lives.** Two documents can share a name in
different folders; the location column tells them apart. Search matches name
and aliases through the reference policy's `matchReferenceName` (the one
matching rule every menu ranks by), then the path.

## Key rules

- **`allowSpaces` is on, and has to be.** Names have spaces; a trigger that
  stopped at the first one could not find "The Second Gate". The cost is that
  the match runs to the end of the text node, so a query carrying `]` offers
  nothing.
- **The brackets after the caret are already there.** Auto-pairing writes `]]`
  when the writer types the second `[`, so a choice replaces the range up to
  and including them (`autoClosedRunLength`).
- **The create row inserts a link, never a document** (mockup 06 state D). It
  points at `<holder's folder>/<typed>.md` (`siblingDocumentAddress`, the same
  filename rule a follow's Create uses), so the chip is dashed until the
  document exists and Create makes it at exactly that address. It steps aside
  when a document is already there.
- **The catalog is the host's**, read at open, and null withdraws the trigger.
  It carries the holder's URI, so rows and insertion agree about where the link
  is spelled from.

## Anti-patterns

- Spelling an href here instead of through `spellDocumentHref`.
- Converting `[[…]]` text into a link anywhere.
- Reimplementing any part of the suggestion lifecycle, or a second ranking
  rule beside `matchReferenceName`.

→ [`../suggestion/suggestion-lane.ts`](../suggestion/suggestion-lane.ts) — the
  mechanism every lane shares
→ [`../auto-pair/AGENTS.md`](../auto-pair/AGENTS.md) — who wrote the `]]`
→ [`../../links/AGENTS.md`](../../links/AGENTS.md) — what a link means once it exists
→ [`../../chrome/AGENTS.md`](../../chrome/AGENTS.md) for the layer, keymap, and Esc contracts
