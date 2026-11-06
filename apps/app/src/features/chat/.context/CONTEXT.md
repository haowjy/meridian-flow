# features/chat — Context map

- [Turn composition](turn-composition.md): the process/text/artifact render model.
- [Activity row anatomy](activity-row-anatomy.md): document doors, the
  stretched-button row, and why row chrome carries no colour.
- [Turn rhythm and actions](turn-rhythm-and-actions.md): spacing ownership and the
  action row.
- [Tool expands](tool-expands.md): what opens behind a tool row.
- [Turn edit receipts](turn-edit-receipts.md): committed change records, Undo/Redo
  and conversation reveal.
- [Composer write mode](composer-write-mode.md): the Work-scoped write-mode
  control and composer sizing.
- [Draft review](../../draft-review/.context/draft-review.md): the projection and
  commands behind `useDraftDock`.
- [Failure cards](failure-cards.md): anchors, the announcer and failure logging.
- [Compaction surfaces](compaction-surfaces.md): dividers and queued commands.
- [Fork and handoff](fork-and-handoff.md): navigate-first creation, the brief card
  and a fork's inherited view.
- [Failed-reply Retry](failed-reply-retry.md): the optimistic reply and its refused
  and lost cases.
- [Thread live updates](thread-live-updates.md): the one mounted subscriber.

Unadmitted messages belong to
[`client/chat-submissions`](../../../client/chat-submissions/AGENTS.md). The
composer clears when the journal accepts ownership, not when the network
completes. Pending upload bytes don't persist; uploaded reference atoms do.
`CreationComposer` sends through the route-owned pane-aware command and writes no
URL.

Child-thread doors use the project shell's `ChatThreadNavigationProvider`, so a
child opens in the same project address space rather than in a second chat shell.

Durable change detail renders only through the owning turn receipt; the transcript
adds no conversation-wide aggregate record.

## Render stability

Context values for failure cards, derivation actions and subagent activity keep
their reference until their own facts change, and failure-card readers pass one
anchor's cards through a memoized view, so a change at another anchor doesn't
redraw a settled row. Event callbacks publish the latest committed render before
paint: a render-time ref write can otherwise expose speculative scope or store
actions to operations from the visible screen.
