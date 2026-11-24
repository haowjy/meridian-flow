# collab TODO

- The live agent-edit coordinator: measure paths outside a command that hold a pooled connection while acquiring
  another (inside one, `assertOutsideCommandTransaction` refuses it in dev and test). Restructure
  on demonstrated pool exhaustion; preserve lock order.
- `domain/markdown-document.ts`: evaluate replacing the constrained code schema
  with one shared schema and presentation/input policy ([#212]). Until a safe
  conversion exists, retain the document/code rename guard so normalization
  cannot delete existing content.
- Works mutation boundary (`projects/adapters/work-projection-mutation.ts`):
  determine what remains of [#931].
- A closed Work's dropped create of a Work-only document: `watchBounces` marks the row and ends
  nothing, so an open session of the document keeps rejoining its Live room, at once each time,
  on the server's `document-unknown` until the tab closes it.
- The turn inverse (`adapters/drizzle-turn-inverse.ts`, the card's Undo and the model's `undo`)
  chooses its steps from a capture read before its locks, and `commitStep` does not read the
  ledger again: an Undo of the same part committed between the two (another card press, a
  restore) is taken twice and its deleted words show twice. Read `taken` again under the commit's
  locks.
- The press's `saveLoadedForks`: a fork's first words, still on its save debounce, are in no
  `document_forks` row and in no snapshot `rooms.read` copies inside a transaction
  (`copyInTransaction`), so the press flushes loaded forks before its transaction. Dropping it
  needs the press to read loaded rooms, or a fork's row and snapshot written with its first write.
- The model's `undo` after the writer undid an Undo turn answers "already removed" while the
  turn's words show again: `effectiveActionIndex` counts a write taken once any undo targets it,
  where `restorePlan` follows the chain to the undo receipt that carries the turn's text again.
  Following it needs a stack entry built from another edit's parts (selection, the `edits`
  listing, `commitStep`'s receipt), not one predicate.
- The card offers Undo turn for a turn whose only text change the model undid within the turn:
  `someStands` sees both parts hold their edits, though taking both back changes nothing. The
  press is harmless (the draft reads as before) and the card then shows it restored.

[#212]: https://github.com/haowjy/meridian-flow/issues/212
[#931]: https://github.com/haowjy/meridian-flow/issues/931
