# features/chat — turn rendering and transcript viewport

- `ChatView` calls `viewTranscript` once. A component that selects, filters or
  classifies raw turns makes the app disagree with `./mf thread view`
  ([thread-client](../../../../../packages/thread-client/AGENTS.md)).
- Snapshot sync and transport recovery own block updates. Views don't apply
  snapshots or synthesize streaming turns.
- `TurnList` is the only transcript scroller.
- Rows expand and document names navigate; only the explicit chat icon opens a
  child chat.
- Every chat failure is a card from `chatCards`, shown only while the writer can
  act on it. No red text lines.
- Chat shows this chat's changes, never the Work's whole list; review commands
  belong to `features/draft-review`.

Contracts, one page per concern: [`.context/CONTEXT.md`](.context/CONTEXT.md).
Deferred work: [TODO](.context/TODO.md), [FUTURE](.context/FUTURE).
