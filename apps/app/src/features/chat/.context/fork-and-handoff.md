# Fork and handoff

The contracts are the server's (`threads/domain/derive-conversation.ts`, the
transcript route's `inherited` range, the handoff seed codecs). Code lives in
`derivation/`.

## The actions

Hand off also sits under a writer message the model has, which is how a writer hands
off a source whose reply is still streaming. A queued, sending or failed message
offers none: a queued one is chained after the streaming turn, so the server's cutoff
rule would move it back silently.

The server normalizes the cutoff to the last settled turn at or before it. `ChatView`
provides a `TurnDerivation` only for a primary chat the server already has
(`canDeriveFrom`).

Hand off opens the shared `AgentPickerPanel` with the source's Agent focused, by
revision then by name, so Enter hands off to the same Agent. A row's tooltip waits
until the writer moves through the list, and one Escape closes the picker even with a
tooltip open.

## Navigate first

`startDerivation` mints the destination id, journals the intent in `sessionStorage`,
inserts an optimistic thread and opens it, and only then posts to the idempotent
create-or-get route.

- `optimisticForkPrefix` drops model responses, which the server's read lacks, so a
  reply's Info doesn't appear and then vanish.
- A message sent before the thread exists is held until creation settles
  (`whenDerived`). Submission recovery waits the same way, so a reload during creation
  doesn't look up or replay the message early.
- A reload during creation re-issues the journaled request with the same id before the
  chat reads its snapshot (`useDerivationResume`).
- A failure stays on the destination, as an alert row with Retry under the same id.

## The brief card

The brief is not an inbox command: it runs beside everything and holds the
destination the way a reply does, with no lease or phase. Each seed is a
`handoff-seed` row whose state is the seed's status. A failed seed's shell stays
neutral; `chatCards` supplies the failure and Retry. An older seed is superseded and
carries no failure copy or recovery action.

- **Retry** mints the new seed's id and appends a generating card at the leaf
  (`optimisticHandoffSeed` with the old seed's frozen source), then posts
  `POST /handoff/brief`. The stand-in sits after the turn it followed, so later turns
  render below it and a newer server seed stays the latest. A lost request keeps a
  failure fact on the original seed, not a stand-in.
- **A refused Retry** (409 `handoff_retry_unavailable`) wrote nothing. The stand-in
  goes and the snapshot refreshes.
- **Retry waits while the chat is busy.** It stays focusable (`aria-disabled`); the
  server's 409 covers the race.
- **Stop** calls the turn cancel route with the seed's id (`useTurnStop`). A seed the
  server doesn't have yet offers no Stop.

After Stop, focus lands on Retry even while it waits, so a screen reader reads its
wait note with it.

A seed freezes the source's title for display only, so a trashed source reads
"<title> (in the trash)". A message sent during the brief chains after the seed and is
answered once the brief releases the chat. The brief's start and end reach the chat as
a `meridian.thread.status` frame, which revalidates the snapshot.

## The inherited view

`useInheritedView` reads a fork's prefix from `GET /transcript?range=inherited` once;
the server clips the source at the cutoff, so later source turns never appear.
`buildTranscriptModel` puts the prefix ahead of the fork's own turns and marks those
rows `inherited`, never a synthetic anchor row.

- "From <source>" is one message with the link as a placeholder, so translations can
  move it.
- A failed read with nothing standing in shows an alert with Retry where the inherited
  rows would start, never a fork whose history silently vanished.
- Inherited rows never end the transcript or count as the latest reply, so a cutoff at
  a failed reply shows no failure line.
- Inherited replies render as their owner's and have no interrupt answers; inherited
  dividers are read-only.

## `from`

A spawned child's seed message is an inbox delivery, never a bubble, so its
`thread-reference` blocks get a `thread-reference` row. The parent's spawn card names
the same source from its own invocation-card props, so a reload's snapshot renders it
with no journal replay. The `meridian.agent.spawn` frame arrives before the card, so
nothing on the client reads it. `fromThreadRef` is a model handle and never renders.

`SourceChatLink` is the one door to a source chat. A primary in the project's chat list
is live; anything else asks the server with a one-row transcript read, which refuses a
trashed chat.
