# collab TODO

- `adapters/drizzle-drafts.ts` (`ensureThreadPeerDraft`) and the live agent-edit
  coordinator: measure paths that hold a pooled connection while acquiring
  another, including an ambient reply transaction. Restructure on demonstrated
  pool exhaustion; preserve lock order and independent root rebase transactions.
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
- Response-transaction integration: replace the duplicated `deferUntilCommit`
  declarations and participant layer with one unit-of-work port ([#935]).

[#212]: https://github.com/haowjy/meridian-flow/issues/212
[#931]: https://github.com/haowjy/meridian-flow/issues/931
[#932]: https://github.com/haowjy/meridian-flow/issues/932
[#934]: https://github.com/haowjy/meridian-flow/issues/934
[#935]: https://github.com/haowjy/meridian-flow/issues/935
