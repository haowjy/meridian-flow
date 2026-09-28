# Fork and handoff

What the writer sees when they fork or hand off a chat, and what a fork shows
of its source. The contracts are the server's (`threads/domain/derive-conversation.ts`,
the transcript route's `inherited` range, the handoff seed codecs); this file
owns the pixels. Code lives in `derivation/`.

## The actions

Fork and Hand off sit in a finished turn's action row; the turn is the cutoff.
The server normalizes it to the last settled turn at or before it, and an
inherited turn's owner becomes the recorded source. `ChatView` provides a
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
  which has nothing to stop until the server's seed arrives. While it stands
  in, every `handoff_brief` control is that seed's, never a queued row.
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

The seed S is a `handoff-seed` row rendered by `HandoffBriefCard`:

| S | Card |
|---|---|
| `pending` | "Writing the handoff brief" (`briefing`) with Stop; the composer's Stop targets S too |
| `complete` | The brief from the `handoff-brief` block, clipped with "Show the whole brief" |
| `error` | "Handoff brief unavailable", `turn.error` as copy, Retry on the newest seed |
| `cancelled` | "Handoff brief stopped", "This chat continues without a brief.", Retry on the newest seed |

An older seed (a newer one replaced it, or it is inherited) is superseded: a
failed one says "This brief failed." instead of the server's "Try again."
copy, and a stopped one drops "This chat continues without a brief."

A brief whose seed exists is stopped, never withdrawn: its control counts as
answered, so it is never a queued row. Retry enqueues `handoff_brief` with no
seed; until it runs it waits at the tail as a queued control, withdrawable,
and the card hides Retry (the server refuses a second). The new seed appears
at the leaf when the Retry runs; a sent turn is never mutated. After Stop,
keyboard focus lands on Retry (`data-focus-landing`). The source's name links
back to it and says when it is in the trash. A writer message sent during the
brief chains after S and shows Queued.

## The inherited view

`useInheritedView` reads a fork's prefix from `GET /transcript?range=inherited`
(oldest first, a page per 200 turns, across segment boundaries) once; the
server clips the source at the cutoff, so later source turns, compactions, and
undos never appear. Each entry names its owner. `buildTranscriptModel` takes
the prefix ahead of the fork's own turns and marks those rows `inherited`:

- the first row of each owner's run opens with "From <source>" (one message
  with the link as a placeholder, so translations can move it; a link, or
  "(in the trash)" from the owners' `trashed` flag);
- the last inherited row closes with the fork point, "This fork continues here";
- a failed read with nothing standing in shows an alert with Retry where the
  inherited rows would start, never a fork whose history silently vanished;
- inherited rows never end the transcript or count as the latest reply, so a
  cutoff at a failed reply stays the quiet historical marker;
- inherited dividers are read-only (no Undo, Stop, withdrawal, or undo
  advice); inherited replies render as their owner's (lineage and receipts)
  with no interrupt answers; they keep Copy, Fork, and Hand off.

## `from`

A spawned child's seed message is an inbox delivery, never a bubble, so its
`thread-reference` blocks get a `thread-reference` row: a chip, "From
<source>", at the top of the child's chat. The parent's spawn card names the
same source from `fromThreadId` on the `meridian.agent.spawn` frame, which
`useThreadActivity` records (the subscription's catch-up replays it after a
reload). The turn reducer skips that frame: it is read-model state, never a
transcript block.

`SourceChatLink` is the one door to a source chat. The current title wins over
the frozen one. A primary in the project's chat list is live; anything else
asks the server with a one-row transcript read, which refuses a trashed chat.
