# features/chat — turn rendering and transcript viewport

Assistant-turn rendering, transcript rows and the single conversation
viewport. It adapts shared composer, thread, Work and review contracts; it owns
neither session creation, thread persistence nor shared composer presentation.

- `ChatView` calls `viewTranscript` (`@meridian/thread-client`) once. No
  component selects, filters or classifies raw turns; `./mf thread view` prints
  the same view model.
- Snapshot sync and transport recovery own block updates. Views never apply
  snapshots or synthesize streaming turns, and read run state only through the
  thread-client selectors.
- `TurnList` is the only transcript scroller.
- Thinking is collapsed by default and never auto-opens while streaming. Prose
  and artifacts never fold. Only a finished turn ends a reply.
- Document names are the only navigation doors: rows expand, names navigate.
  Only the explicit chat icon opens a child chat.
- Every chat failure is a card from `chatCards`, shown only while the writer
  can act on it. No red text lines.
- Chat shows this chat's changes, never the Work's whole list; review commands
  belong to `features/draft-review`.

Contracts, one page per concern: [`.context/CONTEXT.md`](.context/CONTEXT.md).
Deferred work: [TODO](.context/TODO.md), [FUTURE](.context/FUTURE).
