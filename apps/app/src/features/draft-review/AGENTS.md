# features/draft-review — changes under review

Shared review state and presentation for manuscript, document-change, Work, and
chat surfaces. One change is one server closure class, except a new document's
whole-draft item. Chat and Work can command a draft without opening a review or
joining a room.

## Ownership boundary

- Provider/session/controller own presented scope, selection, generation,
  retained completion, navigation, and focus.
- Command records/executor own per-draft claims, intent ordering, failures,
  read fences, typed admission, and refresh ordering.
- Room/editor adapters own eligibility, room acquisition, paint readiness, and
  live presence; they do not own command delivery or review settlement.
- Draft-only lifecycle owns cross-container settlement/removal. Catalog file
  projection and change attribution remain separate query concerns.

## Rules

- Navigation consumes the row's `contextLocation`; never infer closure from an
  empty change list or omitted row. Use generation-addressed observations.
- No surface-local locks, optimistic hides, or completion stores. Keep command
  Work/thread authority creation-bound (sharing Editor presentation does not
  borrow Editor command authority), and retain completion in the open review.
  A slow or refused chapter never locks another chapter. Archived Works stay
  read-only, and chat generation gates chat batch controls.
- Navigation consumes executor admission: offline clicks do not remove tabs,
  move to another draft, or replay on reconnect. Room ownership is not editor
  paint or writer-delivery ownership; session-layer delivery survives leaving
  review.
- A draft-only Editor tab is visible only in its review Work.
- Formatting-only edits are real server-vended classes, drawn as one localized
  line without a fake text replacement. A ready sole whole-draft item is its
  document row (`isWholeDocumentChange`), not a file header plus a repeated
  change. Change-row excerpts read complete ordered hunk runs, truncated only by
  CSS, never the operations' first-hunk summaries.
- Focus readers are pure and reconcile once per scope. Address focus requests to
  their intended review, not the last rendered selection.
- Accepted per-change commands keep an immutable member set and revision tokens.
  Identical actionable stale answers get one fresh-cut retry; ambiguity and
  permission failures do not retry. Whole-draft commands settle the current
  server branch, and synthetic class keys never reach the server.
- A draft-only tab is the document's one workspace tab and is not persisted.
  Apply settles it in place; gone/404 is not remote Discard evidence. Close and
  Discard target the exact document, Work, and draft identity.
- Review chrome and rows stay one line; only the header shows completion and
  success has no toast. Components receive props/callbacks, while layout stays
  in components and pane continuity stays in `PaintHold`.

Read [the lifecycle reference][reference] before changing state or settlement.
Related decisions: [diff-based review][editable], [command outcomes][authority], and the [runtime recipes](../../../../../docs/qa/draft-review.md).

[reference]: .context/draft-review.md
[editable]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/diff-based-review-is-the-draft-review.md
[authority]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/apply/command-outcomes-are-recorded.md
