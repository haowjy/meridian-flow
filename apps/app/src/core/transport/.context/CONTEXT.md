# Client transport seams

## Dev-only Yjs wire observation

`tapped-websocket.ts` is the optional observer seam for the shared Hocuspocus
socket. `TappedWebSocket` is injected as `WebSocketPolyfill` only behind
`DEBUG_FEATURE_ALLOWED`; production retains Hocuspocus's native WebSocket path.
The adapter observes final binary `send` arguments and native incoming
`message` bytes synchronously, then leaves delivery unchanged. It never parses
Yjs, retains frame bytes, queues work, or lets observer failures escape into
document transport. A new adapter instance is constructed on reconnect;
`socketEpoch` distinguishes those instances while the registered tap owns
page-lifetime sequencing.

The transport owns only the late-bound `YjsWireTap` contract and registration
functions. The dev feature registers the implementation from
`features/debug/trace/install-yjs-tap.ts` at module evaluation, before the lazy
shared socket can be created; runtime overlay enablement controls visibility,
not capture. `notifyYjsRoomAttached` supplies the local `Y.Doc.clientID` needed
to attribute outgoing deletion-only updates, whose bytes contain the deleted
items' creators but not the deleter.

Do not move this observer to `HocuspocusProvider` hooks. Live seam probes found
those are object-level notifications rather than a complete final-byte seam:
one sync-step-2 notification carried zero bytes, and the shared provider's
outgoing hook did not fire. Protocol inspection and `EventRecord` construction
belong in the debug feature, preserving the dependency direction
`features/debug -> core/transport`.
