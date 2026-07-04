# Editor — TODO

## Draft review remaining gaps

Inline draft review is now live: the editor remounts into the `draft:<draftId>`
room, `DraftInlineReviewExtension` owns decorations, the sidebar can activate
and discard operation-scoped hunks, and hunk discard uses the tracked
`HUNK_REJECT_ORIGIN` undo path.

Open gaps:

- **Cursor preservation across live ↔ draft remount.** Scroll uses best-effort
  layout restoration, but selection/cursor restoration is still not deliberate.
- **Review ownership consolidation.** Review entry/exit, preview fetching,
  fallback routing, inline model sync, sidebar state, and discard commands are
  still spread across provider/hooks/components. Collapse them behind one deep
  controller when the interaction model settles.
- **Narrow viewport review parity.** The right rail intentionally hides below
  `lg`; make sure the docked diff panel keeps feature parity for any new
  operation-level actions.

Design reference: [inline-diff-decoration-architecture.md].

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
