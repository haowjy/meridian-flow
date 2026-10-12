# @meridian/thread-client

The framework-free thread socket and message-document core shared by the app
and `./mf`. Keep protocol readiness, deadlines and cursor recovery here so
the clients cannot disagree. Reply following remains client-owned until #768
phase 2 settles its shared contract.

- Platform differences enter through injected ports at each composition root.
  No React, stores, browser or Node globals at module evaluation,
  `import.meta.env`, or DOM types in the public surface.
- Depend on `@meridian/contracts` and the light `@meridian/markup/links`
  subpath, never app or server code, Yjs or ProseMirror.
- Clients own HTTP, auth, persistence, printing, event application and editor
  lifecycle. Observers must not affect product transport behavior.

Read [the contracts](.context/CONTEXT.md) for socket composition, deadline and
recovery guarantees, and message-document serialization.
