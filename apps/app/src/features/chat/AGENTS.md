# features/chat — turn rendering and transcript viewport

This directory owns assistant-turn rendering, transcript rows, and the single
conversation viewport. It adapts shared composer, thread, Work, and review
contracts; it does not own session creation, thread persistence, or shared
composer presentation. Explicit existing-thread Work rebinding is a Chat
adapter only.

## Mental model

- `partitionTurn` converts ordered blocks into one ordered list of Process, Text,
  and Artifact items. Process runs fold by block order and are collapsed by
  default in both live and settled turns. Text and artifacts stay visible and
  close the current process run. Hidden tool protocol is not rendered twice.
- Render keys are positional (`turnId::sequence`), never block IDs. Partition
  does not read transient stream state.
- Durable subagent cards use normalized run identity and delivery mode. A row
  expands or reveals within the current transcript; only the explicit chat icon
  opens a child chat. Completion notices are structured transcript events, not
  parsed copy. Run liveness is never a turn block: a saved running card with no
  live lease is `unknown`, not running. Every subagent surface builds on the
  normalized `SubagentRun` and shared `SubagentRow` anatomy.
- `TurnList` is the only transcript scroller. TanStack Virtual owns geometry;
  `useChatFollowScroll` owns follow/free policy. No child transcript surface
  adds a scroller.
- Snapshot sync and transport recovery own addressed block updates and history
  reconciliation. Views must not apply snapshots or synthesize missing streaming
  turns. Queued writer state is projected from the pending inbox; usage blocking
  is the server's `credits_exhausted` fact.
- Chat consumes draft review through the chat's changes, not the Work's entire
  list. Review commands remain owned by `features/draft-review`.

## Interaction rules

- Thinking is default-collapsed; never auto-open it during streaming.
- Document names are the only navigation doors in the timeline. Rows expand;
  names navigate. Do not nest a name button inside a row button.
- Only a finished turn ends a reply. Continuations, server steers, and active
  background work keep the reply open and suppress settled action spacing.
- First and later sends use the account-stamped submission journal. Failure stays
  on the writer row; ambiguous records retain their witness; Edit transfers
  structured writing once. Composer drafts have one tab-local session owner and
  clear synchronously into the journal on Send. Work selection is prospective
  context, not a separate creation draft. Pending upload bytes do not persist,
  but successfully uploaded reference atoms do. `CreationComposer` sends through
  the route-owned pane-aware command and never writes a URL.
- Inline review uses server Apply/Discard commands, not browser mutation history.
  A draft-only tab is the document's one tab and settles in place.
- The draft strip is this chat's changes (`useDraftDock`), and a chat with none
  shows no strip. Apply and Discard send the union of this chat's complete
  classes per file; only new documents are one whole-draft item. Each document
  name opens its own review and there is no summary-wide Review command. Work-wide
  lists and Apply all stay on the Work page. Coarse-pointer targets stay 44px.
- Tool rows call writes edits in Draft and direct mode alike, and the fold digest
  omits successful writes because the receipt summarizes them.

## Context map

[Composition](.context/turn-composition.md), [activity rows](.context/activity-row-anatomy.md),
[turn rhythm](.context/turn-rhythm-and-actions.md), [edit receipts](.context/turn-edit-receipts.md),
[composer mode](.context/composer-write-mode.md), [fork/handoff](.context/fork-and-handoff.md),
[failed retry](.context/failed-reply-retry.md), [live updates](.context/thread-live-updates.md),
[compaction](.context/compaction-surfaces.md), [tool expands](.context/tool-expands.md),
and the [chat context map](.context/CONTEXT.md). Deferred work is in
[TODO](.context/TODO.md). Draft-review contracts are
[here](../draft-review/.context/draft-review.md).

- `ThreadRunController` follows a chat by the pure rule in `client/copilot/run-follow.ts`
  from server-decided run identity facts (turn execution, position, reserved messages,
  deliverer, execution end), never by transcript ancestry or timers. Owed messages keep
  Stop active unless blocked by usage (`useOwedMessagesBlocked`).

→ [scroll-follow decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/composer/chat-scroll-follow-state.md)
