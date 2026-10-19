# Write invariants

These invariants protect targeting, provenance, and room/canonical
convergence. “Live” and “canonical” mean the document supplied by the host
coordinator; a room copy is a disposable per-call Y.Doc read from it.

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
  view-scoped while CRDT identity stays document-scoped. A write resolves its
command against the model's view (what its request showed), never against
text the model has not seen; a missing target is ordinary `not_found`. A wrong-target residual shows in the result receipt and is
recoverable through durable undo. Target uncertainty never becomes an approval
or refusal gate on the writer's instruction.
- Equal serialized content does not preserve Yjs identity, tombstones, or
  authorship. Never rebuild an existing replica from Markdown as a merge path.

## Room copies, views and canonical state

Canonical host state is the source of truth and Yjs merge, not
last-writer-wins, is reconciliation. Nothing stays resident between calls:
every model call reads a fresh room copy through `readRoom`, and only an
actually missing coordinator document is an error.

The room copy is the host's document plus the edit scope's staged writes the
host kept against the scope's first-stage snapshot cut; entries it refuses
leave the scope for their receipts and never reappear in a later view. A read
renders from the room copy. A write plans on the view: the room copy at the
model's planning frontier plus the reply's own updates (its settled saves and
the scope's kept staged writes). `preOwnSnapshot`, the concurrency baseline,
is the view before the write. The captured update applies to the room copy for
the echo. Each captured segment takes a fresh client absent from both the view
and the room copy, so parallel calls and write/undo/write in one reply never
reuse a client. A write with no valid view still plans on the room copy (the
one `TODO(M2 W2)` branch in `write-commands.ts`).

Commit re-sync applies durable updates one at a time with persisted origin so
human/agent attribution survives restart. A session snapshot cannot substitute
for that baseline.

Yjs convergence is not intent preservation. Concurrent character edits may
produce mangled prose. Echoes inform the model, but the kernel never gates a
valid writer instruction on destructive evidence.

## Content and result boundaries

Resolved edits carry ProseMirror nodes into apply; apply never reparses or
serializes. Same-block plain-text find uses exact serialized spans; formatted,
escaped, entity, and cross-block cases use splice/reparse structural lowering.

Low-level mutators are not package-root API. Room/coordinator failures map
to `internal_error` except an actual missing coordinator document. Turn identity
and immutable receipts are durable inputs to reversal, not in-memory undo state.

Echo text is verbatim and exact-matchable: truncation may drop a suffix but
never normalizes what it keeps, because a whitespace-collapsing cleanup breaks
the model's retry on text it was just shown (find-all deletion legitimately
leaves double spaces, #383). Result groups carry shared metadata
and item `{ hash, body }` values; hosts keep the typed v1 result beside its
rendered text and never parse rendered text back into protocol data.
