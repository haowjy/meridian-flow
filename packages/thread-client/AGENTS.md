# @meridian/thread-client

The thread client core shared by the app and `./mf`: the thread socket client, the message builder, and (phase 2)
reply following. Code lives here when the two clients would otherwise disagree about what happened.

- Framework-free and platform-neutral: no React, no stores, no browser or Node globals touched at module
  evaluation, no `import.meta.env`, no DOM types in the public surface. Platform differences enter through ports
  injected at each client's composition root.
- Depends on `@meridian/contracts` for wire types and readers. Never on `apps/` or server code.
- Each client keeps its own I/O policy (HTTP, auth, persistence, printing, the store).

## Thread socket

`ThreadSocketClient` owns connect, server-`connected` gating, thread subscribe
and resume, sequenced dispatch and deduplication, gap notification before cursor
advancement, reconnect and backoff, catalog subscriptions, and interrupt answers.
Socket generations fence stale product callbacks; close observation precedes
that fence so controlled closes remain visible. Gap consumers recover truncated
history through snapshots. Cancellation uses the injected HTTP operation.

Inject `url`, `webSocketFactory`, `toError`, and `cancelTurn`; optional
`connectivity` supplies recovery hints and success reporting, and optional
`observer` receives final string frames, open, and close. The app's
`TransportProvider` owns browser composition and supplies observation only under
its build-time debug gate. Observer adapters must not throw or affect transport.
`SocketLike` and `SocketClose` are platform-neutral contracts; ready states use
the protocol constants 0 (connecting) and 1 (open). Timers, clocks, and randomness
remain late-bound globals, preserving existing reconnect timing.

## Message documents

Non-editor callers use `buildMessageDoc`: skills, prose and references are inline
children of one paragraph; authored newlines become `hardBreak` nodes, as in the composer.
Its typed construction shape prevents top-level inline nodes. The serializer still
accepts editor JSON so browser schema and editor lifecycle remain app-owned.

`serializeMessageDoc` reads plain JSON, preserving authored spacing and occurrence order.
References spell canonical Markdown links through `@meridian/markup/links`; image-capable
references also emit an image block. Submitted identities deduplicate by document and URI,
with draft-upload metadata taking precedence. Skills activate once per slug but every
occurrence remains in the blocks. The canonical walk exposes each source reference
through `onReference`; the app projects its owned uploads from those visits without
walking the document again. Draft snapshots and upload lifecycle ownership stay in the app.
