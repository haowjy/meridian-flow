# Write invariants

These invariants protect targeting, provenance, and runtime/canonical
convergence. “Live” and “canonical” mean the document supplied by the host
coordinator; the runtime replica is a disposable model-side Y.Doc.

## Identity and targeting

- A block's durable identity is its Yjs item `{ clientID, clock }`. The
  displayed hash is the shortest currently sibling-unique prefix and may
  change width. Trail and navigation store the item tuple, not the prefix.
- In-place block reorder is unsupported. A future move must delete the old
  item and insert a new one; position-based drag would silently rebind content
  to another block identity. Never wire a node's `draggable` or default DnD to
  reposition blocks. Figures move by cut and paste; drag-to-place is wanted and
  must be built as delete plus insert
  ([#111](https://github.com/haowjy/meridian-flow/issues/111)).
- Written links are assigned before alignment and never round-trip through
  Markdown. Unchanged refs keep their attributes; ahead refs are registered
  before apply or lock. Fresh creates recheck empty-document admission at the
  journal boundary.
- `remove` structurally removes blocks and takes exactly one scope selector;
  empty-string `replace` remains text-span deletion. Scope addresses are
  view-scoped while CRDT identity stays document-scoped. When canonical state
advances, the runtime rebuilds and resolves the writer's command against the
current document instead of requiring a reread; a missing target is ordinary
`not_found`. A wrong-target residual shows in the result receipt and is
recoverable through durable inverse lineage. Target uncertainty never becomes an approval
or refusal gate on the writer's instruction.
- Equal serialized content does not preserve Yjs identity, tombstones, or
  authorship. Never rebuild an existing replica from Markdown as a merge path.

## Runtime and canonical state

The model edits a memory-only runtime Y.Doc. Canonical host state is the
source of truth and Yjs merge, not last-writer-wins, is reconciliation. A write
may cold-rebuild a stale runtime automatically; only an actually missing
coordinator document is an error. Runtime membership is a set of initialized
documents, not a persisted snapshot or attribution baseline.

Every `read` rebuilds runtime from canonical and replays pending response
updates. `find` reads that same rebuilt document. The write lifecycle is local
mutation, canonical merge, local resync, sync marking, and one echo. Deferred
commit collapses only merge/resync to one operation; it does not reuse the
runtime doc as the commit source.

Commit re-sync applies durable updates one at a time with persisted origin so
human/agent attribution survives restart. A session snapshot cannot substitute
for that baseline. Host tool dispatch is sequential; parallel self-writes could
resolve against one stale runtime and self-mangle.

Yjs convergence is not intent preservation. Concurrent character edits may
produce mangled prose. Echoes inform the model, but the kernel never gates a
valid writer instruction on destructive evidence.

## Content and result boundaries

Resolved edits carry ProseMirror nodes into apply; apply never reparses or
serializes. Same-block plain-text find uses exact serialized spans; formatted,
escaped, entity, and cross-block cases use splice/reparse structural lowering.

Low-level mutators are not package-root API. Runtime/coordinator failures map
to `internal_error` except an actual missing coordinator document. Turn identity
and immutable receipts are durable inputs to reversal, not in-memory inverse state.

Echo text is verbatim and exact-matchable: truncation may drop a suffix but
never normalizes what it keeps, because a whitespace-collapsing cleanup breaks
the model's retry on text it was just shown (find-all deletion legitimately
leaves double spaces, #383). Result groups carry shared metadata
and item `{ hash, body }` values; hosts keep the typed v1 result beside its
rendered text and never parse rendered text back into protocol data.
