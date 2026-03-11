---
detail: standard
audience: developer
---
# ws-transport-v2: What's Weird + Other Bugs

Two sections: things that are weird/surprising in the codebase that implementers should know about, and bugs we found but are NOT fixing in this stage.

## What's Weird

Things that might trip up an implementer or seem wrong but are intentional.

### W-1: bootstrapAuth reads first WS message as JWT
The auth pattern sends a raw JWT string as the first WebSocket message, not a JSON object, not a query param, not a header. This is intentional -- it avoids exposing tokens in URLs/logs. The v2 document handler keeps this pattern.

### W-2: Y.Doc state is loaded from DB on every Acquire, not from a cache
There is no warm cache on the backend. Every time a document session is acquired (refCount 0->1), it loads full state from Supabase. This is by design -- the DB is the source of truth. The frontend warm pool caches the Y.Doc client-side to avoid re-fetching.

### W-3: Proposal broadcasting goes through the collab handler, not a separate service
Proposal mutations (accept/reject/etc.) are handled in the collab handler layer, not the proposal service. The service does business logic; the handler does WS broadcasting. This means the handler has coupling to both proposal and collab concerns.

### W-4: collabInboundRateTracker uses a custom sliding window, not token bucket
The current rate limiter is a bespoke implementation using a circular buffer of timestamps. Being replaced with stdlib rate.Limiter (token bucket) in Phase 0. The behavioral difference is minor for our use case.

### W-5: Heartbeat is server-initiated, client-responds
Not the typical ping/pong. Server sends a JSON {"type":"heartbeat"} message, client echoes it back. This is because x/net/websocket did not support protocol-level ping/pong well. coder/websocket does support it, but we keep the application-level heartbeat for consistency and because it also serves as the JWT expiry check point.

### W-6: Frontend useDocumentCollab has a 300ms subscription debounce
To avoid rapid subscribe/unsubscribe when switching tabs. Being replaced by the warm pool pattern, which is a better solution. Delete documentSubscriptionDebounce.ts.

### W-7: ycrdt (Yjs via Rust/WASM) is used, not yjs (JavaScript)
The backend uses y-crdt (Rust Yjs implementation) via CGo bindings. The frontend uses the standard JavaScript yjs library. They are wire-compatible but have different APIs. Implementers should not assume yjs API names map to ycrdt.

## Other Bugs (not fixing now)

Bugs discovered during review that are out of scope for Stage 1.

### OB-1: Snapshot handler race (known-bugs #6, #7)
The snapshot handler has two bugs where concurrent snapshot requests can corrupt state. These are in the REST endpoint (collab_snapshot.go), independent of WS transport. Tracked but not fixed in v2.

### OB-2: Subscribe() nil Session race (known-bugs #13)
SubscriptionService.Subscribe reserves a map slot with nil Session before Acquire completes. Concurrent GetSubscription can find nil Session and panic. This code is being DELETED in v2 (SubscriptionService removed), so the bug goes away. But worth noting in case someone looks at the old code.

### OB-3: No persistence retry on debounce flush failure
If runDebouncePersist fails to write to Supabase, the error is logged but not retried. The dirty flag stays false (it was cleared before the write attempt). A subsequent write will trigger a new flush, but the failed update could be lost if the session is released before another write occurs. Low probability, would need a circuit breaker or retry pattern to fix properly.

### OB-4: No connection draining on server shutdown
When the server shuts down (SIGTERM), active WS connections are not gracefully drained. Clients get a TCP RST. Should add a shutdown hook that sends close frames and waits for in-flight flushes. Not in scope for Stage 1.
