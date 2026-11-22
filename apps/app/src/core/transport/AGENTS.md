# core/transport — Client transport seams

Browser transport for collaborative documents (`loro-room-transport.ts`, on
`loro-protocol` over `/ws/loro`) and thread socket adapters. The thread socket client lives
in `@meridian/thread-client`.

- The transport carries envelopes and versions; it never imports into a `LoroDoc` itself.
  Peers' batches go to `copy.importRemote`, which the session runs through the composition
  guard, so an import never lands under an open IME composition.
- A local batch is sent only after the session stored it in the IndexedDB copy. On every
  Join the transport sends `copy.exportSince(serverVersion)`, so a reconnect resends whatever
  the server lacks; nothing keeps an outbox of frames.
- `subscribeStatus` publishes the current status synchronously, then every later
  transition. `DocumentSession` derives its first status from that callback, and a
  deferred emission opens a timing gap between transport and session snapshots.
- New network connections subscribe to the injected `ConnectivityHintsPort`; don't
  add private window connectivity or wake listeners.

Message, status and Join contracts: [`.context/CONTEXT.md`](.context/CONTEXT.md).
