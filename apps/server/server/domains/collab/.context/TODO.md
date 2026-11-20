# collab TODO

- The live agent-edit coordinator: measure paths outside a command that hold a pooled connection while acquiring
  another (inside one, `assertOutsideCommandTransaction` refuses it in dev and test). Restructure
  on demonstrated pool exhaustion; preserve lock order.
- `context/adapters/project-context-availability.ts` `lookup`: reached from a model edit's
  `links.prepare`, it joins the command transaction and so reads its heads, documents, folders,
  removals and branches at read committed, not as one repeatable-read cut. The generation is read
  first, so a torn read errs toward newer data; no wrong outcome is shown. Read it under the tree
  scope's locks if one appears.
- `domain/markdown-document.ts`: evaluate replacing the constrained code schema
  with one shared schema and presentation/input policy ([#212]). Until a safe
  conversion exists, retain the document/code rename guard so normalization
  cannot delete existing content.
- `adapters/drizzle-journal.ts`: profile retained
  history decoding, materialization and encoding before choosing incremental
  reads ([#932]). Preserve delete-only changes, committed-prefix append,
  exact-inverse revision checks and live authority fencing.
- Works mutation boundary (`projects/adapters/work-projection-mutation.ts`):
  determine what remains of [#931].
- Live document persistence and mutation adapters: move the remaining live
  in-process/advisory lock model to checkpoint, tail and revision under [#934].
- A Work's purge deletes its tree records but leaves its suggestion marks in Live documents:
  nothing reads them, but they stay in the bytes. Reject them in the purge, as a Discard press
  would.
- The model's edit list (`model-inverse-policy.ts`) says `changed` for an edit whose
  suggestions the writer applied; drafts said `applied`. Telling the two apart needs the press's
  text effects (`press_text_effects`) read beside the edit's parts.
- A closed Work's dropped create of a Work-only document is no longer ended client-side by
  `watchBounces`, so its Live room can retry `DOCUMENT_UNKNOWN` until the tab closes it.
- Dead after drafts: agent-edit's `diff` exports (`apply-record`, `restorations`,
  `draft-base`, `REVIEW_BASE_FRAGMENT`) and `provenance.ts`'s reserved-namespace guard
  (`SERVER_OWNED_ROOTS`), which protects roots nothing writes now. Delete them with their tests.

[#212]: https://github.com/haowjy/meridian-flow/issues/212
[#931]: https://github.com/haowjy/meridian-flow/issues/931
[#932]: https://github.com/haowjy/meridian-flow/issues/932
[#934]: https://github.com/haowjy/meridian-flow/issues/934
