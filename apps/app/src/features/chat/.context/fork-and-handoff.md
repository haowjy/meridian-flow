# Fork and handoff

What the writer sees when they fork or hand off a chat, and what a fork shows
of its source. The contracts are the server's (`threads/domain/derive-conversation.ts`,
the transcript route's `inherited` range, the handoff seed codecs); this file
owns the pixels. Code lives in `derivation/`.

## The actions

Fork and Hand off sit in a finished reply's action row; the turn is the
cutoff. Hand off alone also sits under a writer message the model has
(`HandoffTurnAction` in `UserTurn`): the handoff then includes that message,
which is how a writer hands off a source whose reply is still streaming (the
brief reports the message as the open request). A queued, sending, or failed
message offers none: a queued one is chained after the streaming turn, so the
server's cutoff rule would move it back silently. Fork stays on replies. The
message's row reveals on hover or focus like a reply's actions, stays visible
on touch, and opens the picker toward the chat (`align="end"`).

The server normalizes the cutoff to the last settled turn at or before it, and
an inherited turn's owner becomes the recorded source. `ChatView` provides a
`TurnDerivation` only for a primary chat the server already has
(`canDeriveFrom`), so a subagent's view and a chat still being created show
neither action.

Fork takes no Agent choice. Hand off opens the shared `AgentPickerPanel` in a
popover with the source's Agent selected and focused (by revision, then by
name), so Enter hands off to the same Agent. A row's tooltip waits until the
writer moves through the list (the focus the picker lands on opens none) and
opens below the row, inside the screen. One Escape closes the picker even
while a focused row's tooltip is open.

## Navigate first

`startDerivation` (`derive-conversation.ts`) mints the destination id,
journals the intent per tab (`sessionStorage`), inserts an optimistic thread,
marks it pending creation, opens it, and only then posts to the idempotent
create-or-get route. Nothing waits on the server to change the screen:

- A fork shows its inherited prefix at once, cut from the rows the source
  chat already has (`optimisticForkPrefix`), then the server's read replaces
  it with the same turns. The prefix drops model responses, which the read
  lacks, so a reply's Info never appears and then vanishes.
- A handoff shows a generating brief card at once (`optimisticHandoffSeed`),
  which has nothing to stop until the server's seed arrives.
- A message sent before the thread exists shows at once and is sent when
  creation settles (`whenDerived`); if creation failed, the message fails with
  it and keeps Retry. Submission recovery waits the same way, so a reload
  during creation never looks up or replays the message early.
- A reload during creation re-issues the journaled request with the same id
  before the chat reads its snapshot (`useDerivationResume` in `ChatScreen`).
- A failure stays on the destination: an alert row with Retry, which re-posts
  under the same id. The writer is never sent back to the source, and the
  failure is spoken once, by that row.

## The brief card

The brief is not an inbox command: it runs beside everything and holds the
destination the way a reply does, with no lease or phase. Each seed S is a
`handoff-seed` row rendered by `HandoffBriefCard`, and its state is S's status:

| S | Card |
|---|---|
| `pending` | "Writing the handoff brief" with Stop; the composer's Stop targets S too (`composerRun`) |
| `complete` | The brief from the `handoff-brief` block, clipped with "Show the whole brief" |
| `error` | "Handoff brief unavailable", `turn.error` as copy, Retry on the newest seed (a brief cut off by a crash or restart reads the same; its `reason` stays in metadata for diagnostics) |
| `cancelled` | "Handoff brief stopped", "This chat continues without a brief.", Retry on the newest seed |

An older seed (a newer one replaced it, or it is inherited) is superseded: a
failed one says "This brief failed." instead of the server's "Try again."
copy, and a stopped one drops "This chat continues without a brief."

`derivation/useHandoffBrief.ts` owns Retry and Stop:

- **Retry** mints the new seed's id and appends a generating card at the leaf
  at once (`optimisticHandoffSeed` with that id and the old seed's frozen
  source), then posts `{ id }` to `POST /handoff/brief`. The response's seed
  replaces the stand-in by id, and the snapshot's replaces that. The stand-in
  sits after the turn it followed (`placeStandIns`), so later turns render
  below it and a newer server seed stays the latest. `useRetryStandIns` owns
  this optimistic half, shared with a failed reply's Retry. The new card is the
  newest seed, so the old card loses Retry the moment it appears.
- **A refused Retry** (409 `handoff_retry_unavailable`: something holds the
  chat, or the pressed brief is no longer the latest failed one) wrote
  nothing. The stand-in goes, the snapshot refreshes to show the true state,
  and the pressed card says "Couldn't retry." (the cause goes to
  diagnostics, never the writer). A lost request instead keeps the stand-in, failed; its Retry
  re-sends under the same id, so a request that did land replays.
- **Retry waits while the chat is busy** (a live status, which covers a
  reply or a compaction, or a streaming reply). It stays focusable
  (`aria-disabled`) and says "You can retry when this chat is free."; the
  server's 409 covers the race.
- **Stop** marks the seed Stopping at once and calls the turn cancel route
  with S's id (`useTurnStop`, shared with the compaction divider). A failed
  cancel clears Stopping and says "Couldn't stop the brief." on the card. A
  seed the server does not have yet (the opening stand-in, a Retry still
  sending) offers no Stop.

After Stop, keyboard focus lands on Retry (`data-focus-landing`), even while
it waits, so a screen reader reads its wait note with it. The source's
name links back to it and says when it is in the trash. S freezes the source's
title (`turn.metadata.sourceTitle`, projected to the block's
`props.sourceTitle`) for display only, so a trashed source reads "<title> (in
the trash)"; the optimistic seed carries the intent's title. A writer message
sent during the brief chains after S, shows Queued, and is answered once the
brief releases the chat. The brief's start and end reach the chat as a
`meridian.thread.status` frame, which revalidates the snapshot. The brief
card's state changes are announced from the turns
(`useControlTurnAnnouncements`), including a Retry's stand-in.

## The inherited view

`useInheritedView` reads a fork's prefix from `GET /transcript?range=inherited`
(oldest first, a page per 200 turns, across segment boundaries) once; the
server clips the source at the cutoff, so later source turns and compactions
never appear. Each entry names its owner. `buildTranscriptModel` takes
the prefix ahead of the fork's own turns and marks those rows `inherited`:

- the first row of each owner's run opens with "From <source>" (one message
  with the link as a placeholder, so translations can move it; a link, or
  "(in the trash)" from the owners' `trashed` flag);
- the last inherited row closes with the fork point, "This fork continues here";
- a failed read with nothing standing in shows an alert with Retry where the
  inherited rows would start, never a fork whose history silently vanished;
- inherited rows never end the transcript or count as the latest reply, so a
  cutoff at a failed reply stays the quiet historical marker;
- inherited dividers are read-only (no Stop or withdrawal); inherited replies render as their owner's (lineage and receipts)
  with no interrupt answers; they keep Copy, Fork, and Hand off.

## `from`

A spawned child's seed message is an inbox delivery, never a bubble, so its
`thread-reference` blocks get a `thread-reference` row: a chip, "From
<source>", at the top of the child's chat. The parent's spawn card names the
same source from its own invocation-card props (`fromThreadId`,
`fromThreadTitle`), written with the card's first write and kept by the report
update, so a reload's snapshot renders it with no journal replay. The
`meridian.agent.spawn` frame arrives just before the card, with nothing to
hang its source on, so nothing on the client reads it; the turn reducer skips
it. `fromThreadRef` is a model handle and
never renders.

`SourceChatLink` is the one door to a source chat. The current title wins over
the frozen one. A primary in the project's chat list is live; anything else
asks the server with a one-row transcript read, which refuses a trashed chat.
