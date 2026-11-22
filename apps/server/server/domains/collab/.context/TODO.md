# collab TODO

- The live agent-edit coordinator: measure paths outside a command that hold a pooled connection while acquiring
  another (inside one, `assertOutsideCommandTransaction` refuses it in dev and test). Restructure
  on demonstrated pool exhaustion; preserve lock order.
- `context/adapters/project-context-availability.ts` `lookup`: reached from a model edit's
  `links.prepare`, it joins the command transaction and so reads its documents, folders,
  removals and drafts at read committed, not as one repeatable-read cut. The generation is read
  first, so a torn read errs toward newer data; no wrong outcome is shown. Read it under the tree
  scope's locks if one appears.
- `domain/markdown-document.ts`: evaluate replacing the constrained code schema
  with one shared schema and presentation/input policy ([#212]). Until a safe
  conversion exists, retain the document/code rename guard so normalization
  cannot delete existing content.
- Works mutation boundary (`projects/adapters/work-projection-mutation.ts`):
  determine what remains of [#931].
- A closed Work's dropped create of a Work-only document is no longer ended client-side by
  `watchBounces`, so its Live room can retry `DOCUMENT_UNKNOWN` until the tab closes it.
- The Live turn inverse can't undo a word edit grouped with a block the same AI edit moved:
  `editChanges` (agent-edit `content-merge/stands.ts`) skips every group that holds a move, and
  `changeGroups` joins hunks within three words, so `a b c` → `c a b′` is one skipped group.

[#212]: https://github.com/haowjy/meridian-flow/issues/212
[#931]: https://github.com/haowjy/meridian-flow/issues/931
