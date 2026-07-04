# collab TODO

## Reactivated accept safe-degrades moves to `cannot_place`

**Current (shipped):** reactivated (gen>=1, post-undo) accept fails closed to `cannot_place`
on any touched block not provably matched by durable id or unique content. Moves are NOT
auto-re-placed after undo. This is industry-aligned: stale suggestion anchors fail closed
rather than rebase onto diverged text.

**Why:** an accepted AI move, once undone, restores blocks with fresh Yjs ids, so re-applying
it must re-identify blocks by CONTENT — which is provably ambiguous under repeated content or
intervening writer edits. Four attempts to infer moved-block placement from content each
regressed (duplicated or dropped writer text). The correctness invariant — writer content is
never lost or duplicated — outranks auto-re-apply convenience.

**Proper fix (OUT OF SCOPE — primitive-level change):** the only known-correct solution is to
give every block a durable *logical* identity (a ProseMirror node attr, or a parallel `Y.Map`
keyed by logical block id) that survives undo and doc-rewrite, so reactivation re-identifies by
ID, never by content. This is not a tweak to accept logic — it changes how blocks are authored
and persisted everywhere (Yjs has no native move primitive; cf. Kleppmann, *Moving Elements in
List CRDTs*, and Loro's `MovableList`). Deferred deliberately. Research notes:
`work/human-undo-affordance/` (prompts/research-crdt-move-reapply.md).

**Gate:** only pursue the primitive change if interaction telemetry shows reactivation-accept
is common and its `cannot_place` rate is high enough to hurt writers. Blocked on product
analytics (none exists yet) — see GH issue #127 (interaction-telemetry work item).
