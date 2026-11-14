# collab TODO

- Live rooms lose typing the same way a Work draft did: a writer typing offline inside a block a
  peer or the model deletes live has the typing swallowed (`admitLiveWriterUpdate` journals it, the
  room merges it under the deleted block). `findLostEdits` and `recoverLatePeerEdits` are pure over a
  Y.Doc and would apply, but the live path needs a server-authored write into the room that commits
  with the journal row, which no live path has yet (the live agent core writes only as a model
  turn). Build that write, then call recovery from `admitLiveWriterUpdate`.

- `adapters/drizzle-drafts.ts` (`ensureDocumentDraft`) and the live agent-edit
  coordinator: measure paths outside a command that hold a pooled connection while acquiring
  another (inside one, `assertOutsideCommandTransaction` refuses it in dev and test). Restructure
  on demonstrated pool exhaustion; preserve lock order and independent root rebase transactions.
- `context/adapters/project-context-availability.ts` `lookup`: reached from a model edit's
  `links.prepare`, it joins the command transaction and so reads its heads, documents, folders,
  removals and branches at read committed, not as one repeatable-read cut. The generation is read
  first, so a torn read errs toward newer data; no wrong outcome is shown. Read it under the tree
  scope's locks if one appears.
- `domain/markdown-document.ts`: evaluate replacing the constrained code schema
  with one shared schema and presentation/input policy ([#212]). Until a safe
  conversion exists, retain the document/code rename guard so normalization
  cannot delete existing content.
- `adapters/drizzle-journal.ts` and draft provenance readers: profile retained
  history decoding, materialization and encoding before choosing incremental
  reads ([#932]). Preserve delete-only changes, committed-prefix append,
  exact-inverse revision checks and live authority fencing.
- Works mutation boundary (`projects/adapters/work-projection-mutation.ts`):
  determine what remains of [#931].
- Live document persistence and mutation adapters: move the remaining live
  in-process/advisory lock model to checkpoint, tail and revision under [#934].

[#212]: https://github.com/haowjy/meridian-flow/issues/212
[#931]: https://github.com/haowjy/meridian-flow/issues/931
[#932]: https://github.com/haowjy/meridian-flow/issues/932
[#934]: https://github.com/haowjy/meridian-flow/issues/934
