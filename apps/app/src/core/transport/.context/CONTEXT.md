# Client transport seams

## Dev-only wire observation

The two client sockets use their canonical transport seams. `TappedWebSocket`
observes the shared Hocuspocus socket's final binary frames.
`SocketLifecycleController` observes the thread/agent socket's lifecycle and
final string frames. Both are active only behind the build-time debug gate;
production retains native WebSockets without capture. Neither seam parses or
retains frames, and observer failures never escape into product transport.
`socketEpoch` distinguishes reconnects while each registered tap owns
page-lifetime sequencing.

Core owns only the late-bound, transport-specific `YjsWireTap` and
`ThreadWireTap` contracts. The debug feature registers both implementations in
one authenticated-route composition action, before either socket can be
created; runtime overlay enablement controls visibility, not capture. Separate
tap interfaces prevent thread strings from broadening the Yjs byte contract.
`notifyYjsRoomAttached` supplies the local `Y.Doc.clientID` needed to attribute
outgoing deletion-only updates, whose bytes contain the deleted items' creators
but not the deleter.

Do not move this observer to `HocuspocusProvider` hooks. Live seam probes found
those are object-level notifications rather than a complete final-byte seam:
one sync-step-2 notification carried zero bytes, and the shared provider's
outgoing hook did not fire. Protocol inspection and `EventRecord` construction
belong in the debug feature, preserving the dependency direction
`features/debug -> core/transport`. Thread inspection follows the same boundary
and must only emit allowlisted classifications and identifiers; no agent, user,
tool, catchup, or error content may enter an `EventRecord`.

The thread socket's client wire vocabulary is `subscribe`, `unsubscribe`,
`resume`, `pong`, and `interrupt.respond`; its server vocabulary is `connected`,
`subscribed`, `event`, `gap`, `error`, and `ping`. Turn cancellation is an HTTP
operation through `cancelTurn`, not a WebSocket message. Keep these names aligned
with `@meridian/contracts/protocol` rather than inferring them from UI actions.
