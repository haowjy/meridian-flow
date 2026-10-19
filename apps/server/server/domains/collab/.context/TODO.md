# collab TODO

Open follow-ups must preserve immutable edit identity, durable authority fences,
and the close/end-use kernel.

## Per-change Apply Undo

Expose per-change Apply Undo through the existing immutable edit-part and
forward-inverse authority. Lane A builds atomic Apply; this does
not need a separate reversal planner or mutable receipt.

## Connection ownership

Audit paths that hold a pooled connection while acquiring another:
`ensureThreadPeerDraft` when called from an ambient transaction, and the live
agent-edit coordinator's room copy, read outside the response transaction while
it is open. Restructure only if concurrency measurements show pool
exhaustion; preserve the lock order and independent root pull transactions.

## Code representation

Evaluate moving code from a mounted constrained schema to presentation and
input policy ([#212](https://github.com/haowjy/meridian-flow/issues/212): one
schema everywhere, prose affordances disabled through commands, paste, and
transaction filters rather than schema node removal, so a document/code rename
becomes a metadata flip). Until an explicit conversion seam exists, preserve the
current schema guard and refuse document/code renames, because remounting the
other schema against existing content could let normalization delete it.

## Attribution and retained state

The concurrent-journal scan reads and decodes every row of the Work draft
generation on each save, since containment in the view is its only skip. Profile retained
state materialization, encodes, persistence, and live→Work pulls before
choosing an incremental checkpoint or captured-state design. Keep delete-only
changes, the revision fence on draft rewrites (appends are sequenced and
unfenced), live authority fencing and stable draft room identity,
and the final concurrency fence intact. [#932] tracks the provenance side:
sequence it after the diff-based review re-lands ([#862]), so nothing that
change deletes is optimized first.

## Draft store follow-ups

These mechanisms still run beside the draft store and each has an owner.
Do not port them onto the store or extend them.

- **Work projection on operations** ([#931]): keystrokes already take no Work
  lock and count nothing (the projection job does it afterward), and the Works
  mutation boundary no longer counts. Operations (pulls, Discard,
  Undo, draft creation) still lock the Work for lifecycle order and touch it in
  their own transaction. Decide whether anything of #931 remains before
  scheduling it.
- **Live documents** ([#934]): collab's own live paths (Markdown writes, push,
  reversal) still use the in-process `withDocument` mutex, the advisory lock and
  in-place room mutation (agent-edit saves only append and deliver after commit); they move to checkpoint, tail
  and revision after [#862].
- **One unit-of-work port** ([#935]) replaces the six `deferUntilCommit`
  declarations and the response-transaction participant layer.

[#862]: https://github.com/haowjy/meridian-flow/pull/862
[#931]: https://github.com/haowjy/meridian-flow/issues/931
[#932]: https://github.com/haowjy/meridian-flow/issues/932
[#934]: https://github.com/haowjy/meridian-flow/issues/934
[#935]: https://github.com/haowjy/meridian-flow/issues/935
