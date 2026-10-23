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
  Hosts hold one `SyncedThread` per chat; `syncedTurnStore` is the one adapter over it. Do not fork reducer behavior into a client.
- The chat's sync lives here too: `createThreadSync` (`sync/`) decides when to read, what is
  missing, how a read applies and joins replay, and in what order frames reach the turns. Hosts
  give it ports (state cell, `requestSnapshot`, `observe`, signal) and never re-implement those
  rules; it never fetches, and every completed read comes back through `receive`.
- The transcript view model lives in `view/`: `viewTranscript` decides, as
  pure functions over plain inputs, which rows a chat shows and what each
  reply's items are. The app draws its output and `./mf thread view` prints it.
  It emits counts, kinds and numbers; Lingui and `Intl` strings stay in the
  app. The server uses the same rule for a failed reply that draws nothing.
- Every chat failure the writer sees is a card from `chatCards` (`cards/`), a
  pure projection over facts. React and `./mf` draw cards by anchor and decide
  nothing about them.
- Run state is selectors over one whole `RunState` record and this device's
  intents (`run-state/`). No store: hosts hold the view, and the newest record
  wins by `version`. Never derive a run fact from execution ids, stream order or
  timers, and never compose a record from parts.
- Hand-back commands (Stop, the x, Cancel queue) run through one operation in `hand-back/`
  over explicit ports; Send now shares its answer classifier (`postSendNow`). Clients adapt
  storage, editor and printing, and never re-implement the lifecycle.
- Share a decision's inputs and recovery, not only its reducer. A rule that
  needs a snapshot to finish (a divider waiting for its anchor, a waiting
  message the stream didn't carry) exposes what waits, and both hosts refresh
  from it; otherwise `./mf` silently diverges.
- Clients own HTTP, auth, persistence, printing and editor lifecycle.
  Observers must not affect product transport behavior.

Read [the contracts](.context/CONTEXT.md) for socket composition, deadline and
recovery guarantees, the view model and failure cards, message-document
serialization and its hand-back inverse, the seq fences on removals and
dividers, and the run-state selectors.
