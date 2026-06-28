# Editor — TODO

## Figure drag-to-place (reimplement as delete + insert)

**Want:** let writers drag a figure/image to reposition it (real need — placing
images where they belong in the prose).

**Why it's not just `draggable: true`:** ProseMirror's default drag-drop moves a
node *in place*, and y-prosemirror reconciles a reorder by **slot** — it keeps each
Yjs item id pinned to its position and rewrites content into it. That **re-binds
block hashes** (the moved figure, and every block it jumps over, get new hashes),
which breaks agent-edit's "block hash = stable block identity" contract. See the
no-in-place-reorder policy in `packages/agent-edit/.context/CONTEXT.md`.

We removed `draggable: true` from `figure` (here and in
`packages/prosemirror-schema`) so the inconsistency is gone; figures currently move
via cut/paste (clean delete+insert).

**Implementation when we build drag-to-place:**
- Intercept the figure drop (custom `handleDrop` / drag handler) and decompose the
  move into **delete-old-node + insert-new-node** at the drop position — never let
  PM's default in-place reconciliation run.
- The reinserted figure gets a fresh Yjs item id (correct: it's "the figure, now
  here"), and no other block's hash changes.
- Add a test asserting a figure move leaves every *other* block's hash unchanged and
  gives the moved figure a new id.
- Keep parity: any schema-spec change stays mirrored between
  `apps/app/src/core/editor` and `packages/prosemirror-schema` (`schema-parity.test.ts`).
