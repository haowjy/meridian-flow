# collab TODO

Open follow-ups must preserve immutable edit identity, durable authority fences,
and the one push/discard kernels.

## Per-change Apply Undo

Expose per-change Apply Undo through the existing immutable edit-part and
forward-inverse authority. Apply currently confirms settlement only; this does
not need a separate reversal planner or mutable receipt.

## Connection ownership

Audit paths that hold a pooled connection while acquiring another:
`ensureThreadPeerBranch` when called from an ambient transaction and
`createDeferredLiveProjectionCoordinator.withDocument` inside a response
transaction. Restructure only if concurrency measurements show pool
exhaustion; preserve the lock order and independent root pull transactions.

## Empty-paragraph preview

Support empty text blocks in the draft-preview anchoring seam instead of
returning an internal error.

## Code representation

Evaluate moving code from a mounted constrained schema to presentation and
input policy ([#212](https://github.com/haowjy/meridian-flow/issues/212): one
schema everywhere, prose affordances disabled through commands, paste, and
transaction filters rather than schema node removal, so a document/code rename
becomes a metadata flip). Until an explicit conversion seam exists, preserve the
current schema guard and refuse document/code renames, because remounting the
other schema against existing content could let normalization delete it.

## Attribution and retained state

The concurrent-journal scan still decodes retained candidates because its floor
is a commit-bound attribution cursor, not a global maximum. Profile retained
state materialization, encodes, persistence, and thread-peer pulls before
choosing an incremental checkpoint or captured-state design. Keep delete-only
changes, the revision fence on branch rewrites (appends are sequenced and
unfenced), the generation fence on rooms,
and the final concurrency fence intact. [#932] tracks the provenance side:
sequence it after the diff-based review re-lands ([#862]), so nothing that
change deletes is optimized first.

## Generation invalidation

Thread-peer and Work-draft generations remain independent. A reset must evict
the affected thread peers individually; audit for missing invalidation paths
before considering a unified generation API.

## Branch store follow-ups

These mechanisms still run beside the branch store and each has an owner.
Do not port them onto the store or extend them.

- **Apply and settlement.** Settlement claims with renewal, `plan_version`, the
  outbox and lock cut, post-cut joins and the writer-ingress barrier
  (`domain/branch-push-transition.ts`, `adapters/drizzle-pending-settlement.ts`)
  are replaced, not ported, when the diff-based review re-lands ([#862]): Apply
  becomes one bounded attempt and settlement is deleted, closing [#906].
- **Selective-review server path.** `refreshDraftEffect`'s direct `has_effect`
  bump (`adapters/drizzle-draft-effect.ts`), selective Discard's survivor
  re-journal (`adapters/drizzle-branch-push.ts`), Apply staging's revision check
  and the sampled member list (`memberPartKeysComplete`) go together with the
  diff-based review's group-addressed wire ([#862]).
- **Work projection on operations** ([#931]): keystrokes already take no Work
  lock and count nothing (the projection job does it afterward), and the Works
  mutation boundary no longer counts. Operations (pulls, Apply staging, Discard,
  Undo, branch creation) still lock the Work for lifecycle order and touch it in
  their own transaction. Decide whether anything of #931 remains before
  scheduling it.
- **Live documents** ([#934]) still use the in-process `withDocument` mutex,
  the advisory lock and in-place room mutation; they move to checkpoint, tail
  and revision after [#862].
- **One unit-of-work port** ([#935]) replaces the six `deferUntilCommit`
  declarations and the response-transaction participant layer.
- **Delete-only live reply** ([#933], unconfirmed): room recovery is gated on a
  state-vector change, which a delete-only update does not make
  (`adapters/hocuspocus-coordinator.ts`).

[#862]: https://github.com/haowjy/meridian-flow/pull/862
[#906]: https://github.com/haowjy/meridian-flow/issues/906
[#931]: https://github.com/haowjy/meridian-flow/issues/931
[#932]: https://github.com/haowjy/meridian-flow/issues/932
[#933]: https://github.com/haowjy/meridian-flow/issues/933
[#934]: https://github.com/haowjy/meridian-flow/issues/934
[#935]: https://github.com/haowjy/meridian-flow/issues/935
