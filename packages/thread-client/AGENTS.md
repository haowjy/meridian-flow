# @meridian/thread-client

The framework-free thread socket and message-document core shared by the app
and `./mf`. Keep protocol readiness, deadlines, cursor recovery and turn
reduction (`turns/`) here so the clients cannot disagree. Reply following
remains client-owned until #768 phase 2 settles its shared contract.

- Platform differences enter through injected ports at each composition root.
  No React, stores, browser or Node globals at module evaluation,
  `import.meta.env`, or DOM types in the public surface.
- Depend on `@meridian/contracts` and the light `@meridian/markup/links`
  subpath, never app or server code, Yjs or ProseMirror.
- Event application lives here: `createTurnReducer` over a `TurnStore` port.
  The app's Zustand store and `InMemoryTurnStore` both implement it, and the
  app's parity test keeps them equal. Do not fork reducer behavior into a client.
- Clients own HTTP, auth, persistence, printing and editor lifecycle.
  Observers must not affect product transport behavior.

Read [the contracts](.context/CONTEXT.md) for socket composition, deadline and
recovery guarantees, and message-document serialization.
