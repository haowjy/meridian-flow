# Frozen text Apply

[Frozen Apply clicks][frozen] and [later action wins][later] hold the click contract.
`adapters/drizzle-apply-click.ts` owns the atomic storage operation.

`domain/apply-click.ts` keeps the schema with the frozen optimistic base and patched
blocks: independently built schemas have distinct node and mark types, which the merge
kernel can't mix. Receipt membership is classified at that cut, not replayed onto live.

The `restore` check runs under the document lock, so a delete the writer's view didn't
show answers `needs_restore`, however late it landed: nothing changes, the draft stays
pending, and the answer is stored, so a replay returns it. The client asks before
sending a new click with `restore`. Apply reads the addressed document's own lifecycle
row for these decisions, not a branch-wide tree listing.

The route authorizes a deleted item at its source through the draft destination
(`restoreGrant`), not a live grant. A drafted delete of a document live deleted too
uses `restoreGrant` alone: the branch view has no draft of it to grant. When a delete
commits after the route resolved the item, its authorization or the transaction's
grant confirmation refuses the live grant, nothing is claimed, and the route runs the
click once more, which resolves the item as deleted.

Editor Undo sends an `unapply_click` command for the original Apply command. This path
uses the forward-inverse kernel directly against live history, not the model/turn
reversal planner, and folds only the reversed groups out of the current review base.

The command stores one full starting base plus per-group deltas, not a full
before/after document for every group. A later Un-Apply rebuilds the complete delta
chain before selecting effects that remain active, so an earlier partial reversal
can't remove the starting point or an intermediate delta.

`apply.measured` emits compile and Work-boundary times by command id. The draft
append's lock-to-root-commit `holdMs` joins them through an async diagnostic scope. Apply
takes no draft lock outside that append, so `holdMs` covers its whole hold.

The API-core recipe is [atomic Apply](../../../../../../docs/qa/atomic-apply.md). It
does not stand in for integrated browser FIFO and optimistic-review verification.

## The tree cut

A text-only click on a hidden creation reveals it at its own row, and the branch's row
loses only `created` (`endCreatedFact`, a new revision), so its move or delete stays a
pending tree line on the now-live document.

[frozen]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/apply/frozen-apply-clicks.md
[later]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/apply/later-action-wins-at-apply.md
