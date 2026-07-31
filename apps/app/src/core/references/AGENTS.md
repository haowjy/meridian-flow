# core/references — one ranking for everything a writer can point at

The completion engine behind every reference trigger: `[[` and `@` in prose,
`@` in the chat composer's textarea, and the href slot. Candidates in, rows
out. No trigger, no insertion, no menu state, no rendering.

## Mental model

**A candidate exists; an item is a row.** `filterReferenceItems(candidates,
scope, query)` is the whole surface. A host reads its context tree once and
hands over everything it can name; `scope` is what makes `[[` a
documents-only menu and `@` a documents-and-assets one, so the two can never
rank the same query differently.

**Names rank the way the resolver matches them.** Starts-with, then a word
start inside, then anywhere at all; an alias half a step behind its own
title; ties hold the order the host handed them in, which is tree order.
Offering a row the resolver cannot find hands the writer a link that lands
dashed the instant it is inserted.

**Ambiguity is shown, not resolved.** Two documents with one title resolve to
nothing, so both rows say so and both are still offered. Renaming one of them
is the writer's fix, and the menu never guesses which they meant.

**Identity rides along even where prose only spells a name.** Document
candidates carry `documentId` and the canonical `uri`. In-prose insertion
spells the title, but a pick made where a title is ambiguous has to be able
to name identity instead, and rebuilding that above this boundary means
asking the tree twice.

## Key rules

- **No import at all.** Not ProseMirror, not React, not `@meridian/contracts`.
  A trigger that needs the editor belongs in the editor's lane; a candidate
  that needs a contract type is the feed's job to translate.
- **A trigger's own spelling is the trigger's own guard.** `]` or `|` cannot
  ride inside `[[…]]`, so the `[[` lane refuses that query before asking here.
  A rule that is true of one trigger's brackets does not belong in the rank.
- **One ranking implementation, forever.** A second one is two menus that
  disagree about one query, and one of them disagrees with the server.
- **The create row is a row, not a footer**, because the keyboard has to reach
  it; it is offered only when the scope includes documents, and it steps aside
  for an exact title match.

## Anti-patterns

- A kind-specific ranking rule. Kinds differ in what a row carries and in
  which trigger asks for them, not in how a name matches.
- Growing an item with something only one surface renders. That is the host's
  own state, or the menu store's `TMeta`.

→ [`../completion/AGENTS.md`](../completion/AGENTS.md) — the menu state these
  rows are published through
→ [`../editor/extensions/wikilink/AGENTS.md`](../editor/extensions/wikilink/AGENTS.md) —
  the `[[` trigger, and what a choice writes
→ [`../../features/editor/surfaces/link/useReferenceCandidates.ts`](../../features/editor/surfaces/link/useReferenceCandidates.ts) —
  where candidates come from today (the context trees the app already caches)
