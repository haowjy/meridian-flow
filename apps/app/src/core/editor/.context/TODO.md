# Editor — TODO

## Draft review: room switching + inline decorations

Design: [inline-diff-decoration-architecture.md] in `meridian-flow-docs/work/human-undo-affordance/design/`.

**Room switching for draft review — implemented base.** During review, the
editor mounts on the draft Y.Doc (`draft:<draftId>` Hocuspocus room). This is a
session identity change, not a lightweight option flip: `DocumentSessionRegistry`
is keyed by room key, and `EditorView` remounts TipTap when switching live ↔
draft so Collaboration binds to the new Y.Doc/fragment. Open follow-ups:
- Cursor preservation across the remount. Scroll currently gets only the
  existing best-effort stable-layout restoration.
- Inline diff decorations and hunk actions on the draft doc.
- Custom UndoManager origin tracking for hunk discard operations.

**Decoration plugin (reversed geometry).** `DraftInlineReviewExtension`:
editor is on the draft, so insertions (AI-added text) are real editable
ProseMirror content → inline marks. Deletions (live text removed) are absent
→ `Decoration.widget`. Per-hunk reject/discard buttons inline.

**Review ownership consolidation.** The current design has review state spread
across `DraftReviewProvider`, `useDraftPreview()`, `useDocumentReviewSession()`,
`DraftReviewBar`, and `DraftInlineReviewExtension`. Collapse into one deep
controller that owns: review entry/exit, current hunk set, local
remap/invalidation, reject/discard commands, fallback mode. Other pieces
become thin consumers.

**Hunk coalescence.** Writer edits inside/adjacent to an AI hunk merge into
one combined hunk on diff recomputation. Rejecting a combined hunk reverses
ALL contributing updates (AI + writer). This is the intended model.

**Review action versioning.** Reject actions should carry the draft revision
token from the last hunk-model computation. If the draft has changed
materially (concurrent AI writes or live edits), force a hunk-model refresh
before executing.

[inline-diff-decoration-architecture.md]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/design/inline-diff-decoration-architecture.md

## Figure drag-to-place (reimplement as delete + insert) — [#111]

[#111]: https://github.com/haowjy/meridian-flow/issues/111

**Want:** let writers drag a figure/image to reposition it (real need — placing
images where they belong in the prose).

**Why it's not just `draggable: true`:** ProseMirror's default drag-drop moves a
node *in place*, and y-prosemirror reconciles a reorder by **slot** — it keeps each
Yjs item id pinned to its position and rewrites content into it. That **re-binds
block hashes** (the moved figure, and every block it jumps over, get new hashes),
which breaks agent-edit's "block hash = stable block identity" contract. See the
no-in-place-reorder policy in `packages/agent-edit/.context/CONTEXT.md`.

We removed `draggable: true` from `figure` (here and in
`packages/prosemirror-schema`); figures move via cut/paste (delete+insert).

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
