# Research: Generic Multiplexed WebSocket Subscribe/Notify Protocol

Date: 2026-03-30

## Goal
Design a reusable, project-level multiplexed WebSocket protocol with two layers:
1) always-on lightweight notifications for cache invalidation
2) explicit resource subscriptions for heavy/streaming payloads

## Executive recommendation
Use a **single-connection, operation-id multiplexed envelope** (GraphQL WS style) plus **topic/resource routing** (Phoenix/ActionCable/WAMP style), and **separate event classes at protocol level**:
- `notify.*` for invalidation hints only (small payload, no full state)
- `stream.*` for subscribed full data streams (AG-UI, Yjs, etc.)

This avoids over-subscribing heavy streams while keeping cache coherence fast.

---

## 1) Phoenix Channels (Elixir)

### Core protocol shape
- Connection carries many topics.
- Envelope fields: `join_ref`, `ref`, `topic`, `event`, `payload`.
- Lifecycle events include `phx_join`, `phx_leave`, `heartbeat`, `phx_reply`, `phx_error`, `phx_close`.

### Notify vs subscription distinction
- Phoenix does not force a strict notify-vs-stream split.
- In practice, teams model both as events on topics:
  - notify: tiny events like `thread.updated`
  - stream: larger domain events on explicitly joined topics

### Reusability
- Strong. Topic and event names are app-defined, so protocol is generic across resource types.

### Wire example
```json
["1","1","thread:123","phx_join",{}]
[null,"2","phoenix","heartbeat",{}]
[null,null,"thread:123","thread.updated",{"version":42}]
[null,"3","thread:123","phx_leave",{}]
```

### Pitfalls
- Topic explosion if each small entity is a dedicated topic without lifecycle hygiene.
- Missing backpressure semantics at app layer can overload clients.
- Teams often blur event contracts (same event name, changing payload shape).

---

## 2) GraphQL Subscriptions over WebSocket (`graphql-transport-ws`)

### Core protocol shape
- One WS, many concurrent operations keyed by operation `id`.
- Lifecycle: `connection_init` -> `connection_ack`.
- Operation lifecycle: `subscribe` -> (`next` ...)* -> `complete`.
- Keepalive/health: `ping` / `pong`.

### Notify vs subscription distinction
- Built for pushing query result payloads (`next`).
- Notify-only pattern is possible by returning minimal event objects and refetching via REST/HTTP.

### Reusability
- High multiplexing and generic op lifecycle, but GraphQL execution model is opinionated.

### Wire example
```json
{"type":"connection_init","payload":{"token":"..."}}
{"type":"connection_ack"}
{"id":"op-7","type":"subscribe","payload":{"query":"subscription($id:ID!){turnEvents(id:$id){type data}}","variables":{"id":"turn-7"}}}
{"id":"op-7","type":"next","payload":{"data":{"turnEvents":{"type":"delta","data":{}}}}}
{"id":"op-7","type":"complete"}
```

### Pitfalls
- Treating subscriptions as infinite queries without termination discipline.
- Per-event payload over-fetch if schema/events are not carefully minimal.
- Reconnect/resume needs app-level idempotency or replay strategy.

---

## 3) ActionCable (Rails)

### Core protocol shape
- Multiplexed channels over one WS connection.
- Client command frames include `command` + `identifier` JSON string.
- Typical commands: `subscribe`, `unsubscribe`, `message`.
- Server frames include lifecycle types such as `welcome`, `ping`, `confirm_subscription`, `reject_subscription`.

### Notify vs subscription distinction
- Like Phoenix, distinction is convention-driven.
- Common pattern: broadcast small invalidation events broadly; use dedicated channels for rich stream data.

### Reusability
- Strong channel abstraction; `identifier` can encode arbitrary resource type/id.

### Wire example
```json
{"command":"subscribe","identifier":"{\"channel\":\"ThreadChannel\",\"id\":123}"}
{"type":"confirm_subscription","identifier":"{\"channel\":\"ThreadChannel\",\"id\":123}"}
{"identifier":"{\"channel\":\"ThreadChannel\",\"id\":123}","message":{"event":"thread.updated","version":42}}
```

### Pitfalls
- `identifier` contract drift across clients/services.
- Channel callback logic can become stateful and hard to scale without clear boundaries.

---

## 4) Centrifugo

### Core protocol shape
- Generic pub/sub server over WS with JSON or Protobuf.
- Client calls include `connect`, `subscribe`, `unsubscribe`, plus `presence`, `history`, optional `publish`/`rpc` depending on permissions.
- Supports server pushes for publications and optionally join/leave/presence context.

### Notify vs subscription distinction
- Primarily pub/sub payload delivery.
- Notify-only pattern is implemented by publishing minimal invalidation payloads.
- Heavier streams can use separate channels with different retention/recovery settings.

### Reusability
- Very high. Channel namespace/capability model is generic and reusable.

### Wire example (shape)
```json
{"id":1,"connect":{"token":"..."}}
{"id":2,"subscribe":{"channel":"thread:123"}}
{"id":3,"presence":{"channel":"thread:123"}}
{"id":4,"unsubscribe":{"channel":"thread:123"}}
```

### Pitfalls
- Subscribe timeout corner cases can desync perceived vs actual server subscription state; docs recommend reconnect simplification in some failure modes.
- Presence/join/leave can add load and privacy risk if over-enabled.

---

## 5) TanStack Query invalidation over WS

### Core pattern
- WS event says “something changed” (entity/key/version).
- Client maps event to `queryClient.invalidateQueries(...)`.
- TanStack then marks matching queries stale and refetches active ones in background.

### Notify vs subscription distinction
- This is explicit notify-only by design.
- Full data still comes via HTTP/REST (or normal query fn).

### Reusability
- Excellent, because invalidate events can be standardized across features:
  - `{entity:["threads","detail"], id:123, version:42}`

### Wire example
```json
{"type":"notify.invalidate","resource":"thread","id":"123","keys":[["threads"],["thread","123"]],"version":42}
```

### Pitfalls
- Refetch storms if invalidation granularity is too broad.
- Staleness windows if reconnect misses notify events and no periodic reconciliation exists.
- Mapping from server resource semantics -> client query keys can become brittle.

---

## 6) WAMP

### Core protocol shape
- Routed protocol with broker/dealer roles.
- Pub/sub lifecycle uses typed array messages (not object envelopes):
  - `HELLO` / `WELCOME`
  - `SUBSCRIBE` / `SUBSCRIBED`
  - `PUBLISH` / `EVENT`
  - `UNSUBSCRIBE` / `UNSUBSCRIBED`
  - `GOODBYE`
- Topics are URIs; subscriptions return numeric ids.

### Notify vs subscription distinction
- Not explicit as two layers, but easy to model:
  - lightweight events on broad topics
  - heavy events on narrow topics

### Reusability
- Strong, standardized routing semantics and IDs across use cases.

### Wire example
```json
[1, "realm1", {"roles":{"subscriber":{}}}]
[32, 1001, {}, "com.project.thread.123"]
[36, 1001]
[16, 2001, {}, "com.project.thread.123", ["updated", 42]]
```

### Pitfalls
- Array-coded frames are compact but harder to debug manually.
- More conceptual overhead (router roles, realms, ids) than channel-first frameworks.

---

## 7) Ably / Pusher / Supabase Realtime

### Ably
- Multiplexed channels on one connection.
- Distinguishes channel **attach/detach** from listener **subscribe/unsubscribe**.
- Protocol-level actions include connection/channel lifecycle + message/presence and ack semantics.
- Good primitives for reliability (state transitions, continuity/resume signaling).

Wire shape example:
```json
{"action":10,"channel":"thread:123"}
{"action":11,"channel":"thread:123"}
{"action":15,"channel":"thread:123","messages":[{"name":"thread.updated","data":{"version":42}}]}
```

Pitfall: if clients only unsubscribe callbacks but forget detach, transport still receives channel traffic.

### Pusher Channels
- Event envelope model: each message has `event` and `data`, optional `channel`.
- Protocol-level system events (`pusher:connection_established`, `pusher:ping`, etc.) and app events.
- Subscription by sending `pusher:subscribe` with channel name/auth data.

Wire shape example:
```json
{"event":"pusher:subscribe","data":{"channel":"private-thread-123","auth":"..."}}
{"event":"thread.updated","channel":"private-thread-123","data":"{\"version\":42}"}
```

Pitfall: `data` string encoding conventions (including double-encoded JSON in system events) can produce parser bugs.

### Supabase Realtime
- Uses Phoenix-style topic/event envelope and channel joins.
- Subscription configured per channel (broadcast/presence/postgres_changes).
- Good for generic channel model, but payload semantics depend heavily on selected extension (DB changes vs broadcast vs presence).

Wire shape example:
```json
{"topic":"realtime:public:threads","event":"phx_join","payload":{"config":{"postgres_changes":[{"event":"*","schema":"public","table":"threads"}]}}}
{"topic":"realtime:public:threads","event":"postgres_changes","payload":{"data":{...}}}
```

Pitfall: pushing full row-change payloads directly into UI caches can tightly couple DB schema and frontend state model.

---

## 8) Two-layer notify + subscribe pattern in practice

### Where it appears explicitly
- TanStack Query + WS invalidation is the clearest explicit pattern.
- Many teams on Phoenix/ActionCable/Centrifugo emulate it by convention:
  - layer A: broad tiny invalidation broadcasts
  - layer B: selective high-fidelity streams per resource

### Boundary pattern that works
- Define this in protocol contract, not just in docs:
  - `class: "notify"` messages must stay small, include resource identity + monotonic version.
  - `class: "stream"` requires prior explicit subscribe and can carry large or frequent payloads.

### Strong recommendation for your protocol
Adopt a **single generic envelope**:
```json
{
  "v": 1,
  "id": "msg-123",
  "kind": "notify|stream|control|error",
  "op": "connect|subscribe|unsubscribe|ack|event|ping|pong",
  "resource": {"type":"thread|document|turn","id":"..."},
  "subId": "s-42",
  "topic": "optional:derived/topic",
  "payload": {},
  "version": 42,
  "ts": "2026-03-30T12:00:00Z"
}
```

Then enforce:
- Notify lane (`kind=notify`): no full snapshots, no CRDT ops, max payload size cap.
- Stream lane (`kind=stream`): only for active `subId`, resource-specific schema.
- Control lane: `connect`, `subscribe`, `unsubscribe`, `ack`, errors, heartbeat.

### Practical anti-patterns to avoid
- Mixing invalidation hints and full payloads under same event type.
- No versioning/sequence fields (breaks de-dup, replay, and out-of-order handling).
- Global refetch on every notify.
- Hidden per-resource lifecycle differences (special-case logic outside protocol).
- Unbounded server-side subscriptions after client disconnect edge cases.

---

## What to steal directly
1. From GraphQL WS: operation-id multiplexing + explicit operation lifecycle.
2. From Phoenix/ActionCable: topic/resource join/leave semantics and simple event routing.
3. From Ably/Centrifugo: explicit connection/channel state machines and recovery hints.
4. From TanStack pattern: notify payloads as invalidation metadata, not state transfer.
5. From WAMP: strict message type taxonomy and request/subscription identifiers.

## Suggested minimal protocol contract (v1)
- Control messages: `connect`, `connected`, `subscribe`, `subscribed`, `unsubscribe`, `unsubscribed`, `ping`, `pong`, `error`.
- Notify event: `notify.invalidate` with `{resourceType, resourceId, version, keys[]}`.
- Stream event: `stream.event` with `{subId, resourceType, resourceId, seq, data}`.
- Resync strategy: on reconnect, client sends last seen per resource/subId (`version`/`seq`), server decides replay vs refetch-required.
- Auth scope: token claims by resource-type + resource-id pattern.

## Sources
- Phoenix Channels JS / wire envelope and lifecycle: https://hexdocs.pm/phoenix/js/
- Phoenix channels guide: https://hexdocs.pm/phoenix/channels.html
- graphql-transport-ws protocol: https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md
- ActionCable protocol events/constants: https://www.rubydoc.info/github/rails/rails/ActionCable/INTERNAL/MessageTypes
- ActionCable framing examples: https://docs.anycable.io/misc/action_cable_protocol
- Centrifugo client protocol: https://centrifugal.dev/docs/3/transports/client_protocol
- Centrifugo presence/join/leave caveats: https://centrifugal.dev/docs/5/server/presence
- TanStack Query invalidation behavior: https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation
- Real-world WS + React Query pattern: https://tkdodo.eu/blog/using-web-sockets-with-react-query
- WAMP basic profile messages: https://wamp-proto.org/wamp_latest_ietf.html
- Ably protocol definition: https://github.com/ably/specification/blob/main/specifications/protocol.md
- Pusher channels protocol v7: https://pusher.com/docs/channels/library_auth_reference/pusher-websockets-protocol/
- Supabase Realtime protocol: https://supabase.com/docs/guides/realtime/protocol
