# collab TODO

## Draft preview fails on empty paragraphs

The real-stack adversarial-editing probe `p3511` saw the draft-preview endpoint return
HTTP 500 four times when the draft contained empty paragraphs:
`Cannot anchor text offset in block <id> (paragraph) without text`. Reproduce at the
draft-preview anchoring seam and make empty text blocks a supported preview input; this
is pre-existing and was not part of the loaded-room live-pull fix.

## Code files become a display lens; cross-schema rename becomes a metadata flip

**Tracked:** [#212](https://github.com/haowjy/meridian-flow/issues/212) — direction
decided 2026-07-14, awaiting tech-lead scoping.

**Current (shipped):** the client mounts a constrained schema for code (exactly one
`code_block`; `config.ts` `CodeDocument`) and the server serializes code verbatim from
**block 0 only** (`markdown-document.ts`); document ↔ code renames return typed
`invalid_operation` (`context-fs.move-filetype` tests pin this) because remounting the
other schema against existing content would let ProseMirror normalization delete it.

**Decided direction:** one schema everywhere; "code" is presentation + input policy +
line-oriented verbatim serialization, never a different mounted schema. Disabling prose
affordances must be input policy (commands/paste/transaction filters), NOT schema node
removal — an absent node type re-creates the silent-deletion class (#196/#203). Then
rename md ↔ py is a metadata flip, and `CodeDocument` + the block-0 serializer hazard are
deleted. Scoping open: whitespace roundtrip fidelity, doc-wide highlighting (or none in
v1), code-lens paste flattening, migration of existing single-`code_block` docs.

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

## Fix adapter-contract fixture: change-trail persistence wiring

**Affected:** `adapters/__conformance__/drizzle-branches.adapter-contract.test.ts`
("pushes manifest membership journal rows with lineage receipt").

Pre-existing failure (26/27) present at `3c67c3a0` (before the merge-mechanics
branch): the branch-push committer now requires change-trail persistence
(`drizzle-branch-push.ts` `persistRequiredTrail`), but this contract test's
fixture never wires it, so the test throws instead of exercising the manifest
membership path. Wire the change-trail store into the conformance fixture (see
`test-support/change-trail-postgres-harness.ts` for the working pattern) or
delete the case if the manifest path is covered elsewhere. Evidence:
work `draft-simplify` → `mechanics/evidence/0a-baseline.md`.
