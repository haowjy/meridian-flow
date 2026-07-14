# collab TODO

## Cross-schema rename rejects instead of converting (markdown ↔ code swap)

**Tracked:** [#212](https://github.com/haowjy/meridian-flow/issues/212)

**Current (shipped):** rename/move owns filetype transitions atomically; document ↔ code
renames return typed `invalid_operation` (context-fs `move-filetype` conformance tests pin
this). Correct fail-closed remedy for the schema-mismatch bug (PR #207 TN finding 1), but
explicitly a stopgap "until there is an explicit Yjs schema-conversion operation."

**The gap is narrower than "different schemas" suggests.** Code files share the same
Yjs doc, collab pipeline, history, and storage as documents. Only two co-dependent seams
differ: the client mounts a constrained schema for code (exactly one `code_block`;
`config.ts` `CodeDocument`), and the server serializes code verbatim from **block 0 only**
(`markdown-document.ts`). The constraint guarantees single-block; the block-0 serializer is
why the constraint is load-bearing.

**Decision needed (see #212):** Path A — build the conversion as one ordinary collab
transaction (prose ↔ single code_block; both codec halves already exist) atomic with the
metadata flip, live clients remount their editor. Path B — unify: code mounts the document
schema displayed code-first, deleting the mismatch bug class, but verbatim serialization
must then handle non-single-block content. Writer impact today: fixing a mis-named file
means create-new + copy + delete, losing document identity.

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
