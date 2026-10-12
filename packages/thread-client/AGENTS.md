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
