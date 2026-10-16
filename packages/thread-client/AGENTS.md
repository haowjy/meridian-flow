# @meridian/thread-client

The framework-free thread socket and message-document core shared by the app
and `./mf`. Keep protocol readiness, deadlines, cursor recovery, turn
reduction (`turns/`) and run state (`run-state/`) here so the clients cannot
disagree. Every chat decision between the server and the screen is headed here,
never into `apps/app`; the chat session moves the rest.

- Platform differences enter through injected ports at each composition root.
  No React, stores, browser or Node globals at module evaluation,
  `import.meta.env`, or DOM types in the public surface.
- Depend on `@meridian/contracts` and the light `@meridian/markup/links`
  subpath, never app or server code, Yjs or ProseMirror.
- Event application lives here: `createTurnReducer` over a `TurnStore` port.
  The app's Zustand store and `InMemoryTurnStore` both implement it, and the
  app's parity test keeps them equal. Do not fork reducer behavior into a client.
- `view/` is also a subpath, `@meridian/thread-client/view`, for the server: it
  exports `replyDrawsNothing`, the one rule for "this failed reply draws nothing", so the
  server's forgetting and the client's hiding cannot drift.
- The transcript view model lives in `view/`: `viewTranscript` decides the rows
  a chat shows and what each reply's items are, over plain inputs, as pure
  functions. The app draws its output and `./mf thread view` prints it. It emits
  counts, kinds and numbers; Lingui and `Intl` strings stay in the app. Memoized
  by input identity (`WeakMap`) so unchanged turns keep their items. A failed reply
  the chat moved past, with nothing to read, has no row (unless the `refused` input
  names it); the app's `ErrorBlock` draws no failure for it.
- `partitionTurn` (`view/partition-turn.ts`) reads only the turn's ordered
  blocks, never transient stream state. Hidden tool protocol is not rendered
  twice: a call whose card is in the turn shows as that card alone
  (`hiddenToolCallIds`).
- Run state is selectors over one whole `RunState` record and this device's
  intents (`run-state/`). No store: hosts hold the view, and the newest record
  wins by `version`. Never derive a run fact from execution ids, stream order or
  timers, and never compose a record from parts.
- Hand-back commands (Stop, the x, Cancel queue) run through one operation in `hand-back/`
  over explicit ports; Send now shares its answer classifier (`postSendNow`). Clients adapt
  storage, editor and printing, and never re-implement the lifecycle. `handBackCards` decides
  which failures show a card; React and `./mf` decide nothing about them.
- Share a decision's inputs and recovery, not only its reducer. A rule that
  needs a snapshot to finish (a divider waiting for its anchor, a waiting
  message the stream didn't carry) exposes what waits, and both hosts refresh
  from it; otherwise `./mf` silently diverges.
- Clients own HTTP, auth, persistence, printing and editor lifecycle.
  Observers must not affect product transport behavior.

Read [the contracts](.context/CONTEXT.md) for socket composition, deadline and
recovery guarantees, message-document serialization and its hand-back inverse,
the seq fences on removals and dividers, and the run-state selectors.
