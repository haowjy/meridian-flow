# features/chat — turn rendering and transcript viewport

This directory owns assistant-turn rendering, transcript rows, and the single
conversation viewport. It adapts shared composer, thread, Work, and review
contracts; it does not own session creation, thread persistence, or shared
composer presentation. Explicit existing-thread Work rebinding is a Chat
adapter only.

## Mental model

- `partitionTurn` converts ordered blocks into one ordered list of Process, Text,
  and Artifact items. Process runs fold by block order and are collapsed by
  default, live or settled. Text and artifacts stay visible and close the
  current process run. Render keys are positional (`turnId::sequence`), never
  block IDs.
- Durable subagent cards use normalized run identity and delivery mode. A row
  expands or reveals within the current transcript; only the explicit chat icon
  opens a child chat. Completion notices are structured transcript events, not
  parsed copy. Run liveness is never a turn block: a saved running card with no
  live lease is `unknown`, not running. Every subagent surface builds on the
  normalized `SubagentRun` and shared `SubagentRow` anatomy.
- `TurnList` is the only transcript scroller. TanStack Virtual owns geometry;
  `useChatFollowScroll` owns follow/free policy. No child transcript surface
  adds a scroller.
- Snapshot sync and transport recovery own block updates and history
  reconciliation; views never apply snapshots or synthesize streaming turns.
- `ChatView` calls `viewTranscript` from `@meridian/thread-client` once; no
  component selects, filters or classifies raw turns for rows, groups, tool
  pairing, visibility or Retry stand-ins. The app words copy; `./mf thread view`
  prints the same view model.
- The server writes one versioned `RunState` per chat. The app and `./mf` follow
  it only through the same `@meridian/thread-client` selectors (`isBusy`,
  `waitingWriterMessages`, `usageBlockedMessages`, `switchState`), never from
  execution identity, stream order or timers.
- Chat consumes draft review through the chat's changes, not the Work's entire
  list. Review commands remain owned by `features/draft-review`.

## Interaction rules

- Thinking is default-collapsed, never auto-opened while streaming.
- Document names are the only navigation doors; rows expand, names navigate. Never
  nest a name button inside a row button.
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
- The draft dock is this chat's changes (`useDraftDock`), and a chat with none
  shows no draft dock. Apply and Discard send the union of this chat's complete
  classes per file; only new documents are one whole-draft item. Each document
  name opens its own review and there is no summary-wide Review command. Work-wide
  lists and Apply all stay on the Work page. Coarse-pointer targets stay 44px.
- A temporary problem the writer can act on (a failed Stop, a refused Retry, out of
  usage) is a `NoticeCard`, the card every chat failure uses, never a text line under
  or beside a control. A failed Stop and out of usage carry a button (Try again, Add
  usage); a held row reads only "Queued", and the usage card says why. A failure shows
  only while it can be acted on: once a turn follows a failed reply, it leaves no line,
  and with no content no row (`viewTranscript` decides; a refused Retry's card keeps it).
- Stop (the [composer's one button](../../components/app/composer/AGENTS.md))
  hands the waiting messages back as one editable message, in send order with
  blank lines between them, above typed text. A handed-back message never
  reaches the model, a conversation page, a fork, a summary or a snapshot.
  Retry replaces the failed reply in place. An idle queued switch reads
  "Switched to …"; "Switch to … queued" is only for a switch waiting behind a
  running reply.
- **The queue.** One queue per chat: any tab's press takes any queued message into its
  own box, above typed text. A queued row is drawn from `ViewRow.queued` with
  `data-queued` on the article: a dotted `--color-muted-foreground` border, no fill and
  `--color-ink-muted` text (`globals.css`), never opacity. Its status line reads
  "Queued" and the x ("Move to the message box", 44px on coarse pointers). The last queued
  row also has Cancel queue (two or more queued) and Send now (a reply runs). Send now
  stops the reply so the whole queue runs next, hands nothing back, and rings (a spinner)
  while pending or stopping. A lost race (the reply took the message first) shows nothing.
  `useHandBack` adapts the package's hand-back operation (draft store, run-state port,
  `fetch`); `useChatStop` and `useQueueControls` press it, `useSendNow` posts
  `postSendNow`. They hold no rules.
- **The queue's cards** come from `handBackCards` and sit in the composer's notice stack
  (`HandBackCards`), because a committed hand-back has already removed its rows. Try
  again replays the same request; a refused one offers Dismiss only. A queued
  `/compact` or switch whose Stop failed is a card in that control's row ("Couldn't stop
  the compaction.", Try again in Stop's place). No red text lines.
- Tool rows call writes edits in Draft and direct mode alike, and the fold digest
  omits successful writes because the receipt summarizes them.

## Context map

[Composition](.context/turn-composition.md), [activity rows](.context/activity-row-anatomy.md),
[turn rhythm](.context/turn-rhythm-and-actions.md), [edit receipts](.context/turn-edit-receipts.md),
[composer mode](.context/composer-write-mode.md), [fork/handoff](.context/fork-and-handoff.md),
[failed retry](.context/failed-reply-retry.md), [live updates and Stop](.context/thread-live-updates.md),
[compaction](.context/compaction-surfaces.md), [tool expands](.context/tool-expands.md),
and the [chat context map](.context/CONTEXT.md). Deferred work is in
[TODO](.context/TODO.md). Draft-review contracts are
[here](../draft-review/.context/draft-review.md).

→ [scroll-follow decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/composer/chat-scroll-follow-state.md)
