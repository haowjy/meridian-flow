# @meridian/thread-client

The framework-free chat core shared by the app and `./mf`, so the clients cannot
disagree: the thread socket, message documents, turn reduction, the chat's sync, the
transcript view model, failure cards, run state and hand-back commands. Every chat
decision between the server and the screen is headed here, never into `apps/app`.

- Platform differences enter through injected ports. No React, stores, browser or Node
  globals at module evaluation, `import.meta.env`, or DOM types in the public surface.
  Depend on `@meridian/contracts` and the light `@meridian/markup/links` subpath, never
  app or server code, Yjs or ProseMirror.
- Hosts give ports and adapt storage, editor and printing; they never re-implement a rule
  that lives here. Clients own HTTP, auth, persistence and printing.
- `createThreadSync` never fetches: every completed read comes back through `receive`.
- The view model emits counts, kinds and numbers. Lingui and `Intl` strings stay in the app.
- Never derive a run fact from execution ids, stream order or timers, and never compose a
  record from parts.
- Share a decision's inputs and recovery, not only its reducer. A rule that needs a snapshot
  to finish (a divider waiting for its anchor, a waiting message the stream didn't carry)
  exposes what waits, and both hosts refresh from it; otherwise `./mf` silently diverges.
- Observers must not affect transport behavior.

Contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md).
