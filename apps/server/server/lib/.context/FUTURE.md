# server lib — FUTURE

- **Emit structured schema-admission refusal events.** `refuseConnection()` in
  `yjs-ws-handler.ts` closes the transport and aborts hook processing without
  emitting through `EventSink`. Emit one structured, correlated event for each
  typed schema refusal. **Affected:** `yjs-ws-handler.ts`.
