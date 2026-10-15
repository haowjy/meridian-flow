# features/draft-review — changes under review

Shared review state and presentation for manuscript, document-change, Work, and
chat surfaces. A change is a group of the text diff between the draft's
`review_base` fragment and its `prosemirror` fragment, computed in the browser;
there is no server preview. Chat and Work can command a draft without opening a
review or joining a room.

## Ownership boundary

- Provider/session/controller own presented scope, selection, focus (a change
  id), marks visibility, and navigation.
- One review runtime per draft room (`review-runtime.ts`) computes the frame
  (`projectReview(diffBlocks(base, draft))` and its `Y.Snapshot`), derives the
  visible changes, and reconciles command records. Editors attach to it and
  paint; a headless room feeds the same runtime for surfaces with no editor.
- Command records/executor own Apply claims, failures, and refresh ordering.
  Discard of a change or of a draft is not a command; it is an edit.
- Room/editor adapters own eligibility, room acquisition, and paint readiness;
  they do not own command delivery or settlement.
- Draft-only lifecycle owns cross-container settlement/removal.

## Rules

- Review is a pure function of the text. Never store review state beside the
  document: a move, cut, paste or Ctrl+Z changes the text and the review follows.
- Only red (removed) and green (added). Chat names are a best-effort hint on a
  change; nothing gates on them.
- Discard is local, instant, and one Ctrl+Z step: it writes the draft fragment
  under the editor's own undo origin (`draft-discard.ts`). A surface with no
  editor edits the room it holds (`useHeadlessDiscards`) and its row offers Undo.
  There is no card Undo or Redo. Only item Discard (a created, binary or
  live-deleted document) and the Work page's Discard close on the server.
- Every change row carries the frame it was listed from. Apply sends that
  frame's snapshot; Discard finds the change again by pinned position and
  content hash and is a no-op if the text under it changed. Never rebind a
  click to the runtime's newest frame.
- Apply is a server merge, not browser history. `overrode` is a dismissible
  notice, not a gate.
- No surface-local command lock, optimistic hide, or completion store; keep
  commands bound to their creation-bound Work and thread authority. Offline
  clicks do not remove tabs or replay on reconnect.
- An item with no changes left stays open in its room; "No changes left" is
  derived from the projection.
- Room ownership is not editor paint ownership; the room survives leaving
  review. Each editor attachment (tab, dock) owns its painter and command
  handle, so a Discard lands in the history of the editor the writer clicked in.
- A draft-only tab is the document's one tab and is visible only in its review
  Work. The Editor never persists it; the dock persists its one `reviews`
  entry, which settlement removes when stale. Only a command's own outcome
  settles it, never a list, a metadata read or a 404.
- Focus readers are pure and reconcile once per scope. Review chrome and rows
  stay one line; success has no toast. Components receive props/callbacks.

Read [the reference][reference] before changing state, Discard or Apply.
Related decisions: [diff-based review][editable], [command outcomes][authority], and the [runtime recipes](../../../../../docs/qa/draft-review.md).

[reference]: .context/draft-review.md
[editable]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/diff-based-review-is-the-draft-review.md
[authority]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/apply/command-outcomes-are-recorded.md
