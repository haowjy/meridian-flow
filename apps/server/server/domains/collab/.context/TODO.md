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
  exact-inverse revision checks and live authority fencing. Draft generations
  and peer content catch-up are not available optimization boundaries.
- `domain/ports/works-mutation.ts`: determine what remains of [#931]. Keystrokes
  already take no Work lock and count nothing; operations still take the Work
  boundary for lifecycle ordering. Local text Discard uses ordinary append,
  not a server Discard operation.
- Live document persistence and mutation adapters: move the remaining live
  in-process/advisory lock model to checkpoint, tail and revision under [#934].
  Atomic Apply already installs its prepared room effects after root commit;
  do not reintroduce settlement or mutate a warm room inside its transaction.
- `domain/draft-agent-edit.ts` and `adapters/drizzle-drafts.ts`
  (`ensureDocumentDraft`): a draft-mode chat's first text write to a document
  with no Work draft yet is refused `region_changed` after a read (35 of 38
  real-model cases after a drafted move, every mock run). The read finds no
  Work draft and reads live (`thread-peer-core-pool.ts` resolves none), so the
  model's frontier and block hashes are live's; the write then seeds a draft
  with fresh client-1 items ("live shares content, never Yjs items"), whose
  room has no frontier and whose hashes differ. Not a move bug. A fix must keep
  "reads never create these records" (KB `branches-separate-from-works`):
  candidate, since a seed is a deterministic function of live content, a
  no-draft read renders the would-be seed and its frontier carries into the
  draft room the write seeds from the same content. Owner decision needed.
- Response-transaction integration: replace the duplicated `deferUntilCommit`
  declarations and participant layer with one unit-of-work port ([#935]).

[#212]: https://github.com/haowjy/meridian-flow/issues/212
[#931]: https://github.com/haowjy/meridian-flow/issues/931
[#932]: https://github.com/haowjy/meridian-flow/issues/932
[#934]: https://github.com/haowjy/meridian-flow/issues/934
[#935]: https://github.com/haowjy/meridian-flow/issues/935
