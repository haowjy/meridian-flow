# core/transport — Client transport seams

Browser transport for collaborative documents and thread socket adapters. The
thread socket client lives in `@meridian/thread-client`.

- The outbox listener registers on the `Y.Doc` before `HocuspocusProvider` is
  constructed, and only its empty-to-pending edge publishes. Moving the registration
  after the provider lets a command act on the outbox's absence before local bytes
  reach it; publishing per update re-renders every subscribed editor on each keystroke.
- `subscribeStatus` publishes the current status synchronously, then every later
  transition. `DocumentSession` derives its first status from that callback, and a
  deferred emission opens a timing gap between transport and session snapshots.
- New network connections subscribe to the injected `ConnectivityHintsPort`; don't
  add private window connectivity or wake listeners.
- A draft room's socket holds Updates until its SyncStep2 is written; live rooms keep
  the provider's order byte for byte. Don't inject a frame around `send` or release on
  a timer.
- Transport observers receive final frames and don't parse, retain or broaden them.

Message, status and debug-observation contracts:
[`.context/CONTEXT.md`](.context/CONTEXT.md).
