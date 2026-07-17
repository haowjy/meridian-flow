# Client transport seams

## Dev-only wire observation

`tapped-websocket.ts` is the optional observer seam for both client sockets:
the shared Hocuspocus socket and the thread/agent socket. `TappedWebSocket` is
injected only behind the build-time debug gate; production retains native
WebSockets. The adapter observes final binary or string frames synchronously,
then leaves delivery unchanged. It never parses frames, retains data, queues
work, or lets observer failures escape into either transport. A new adapter
instance is constructed on reconnect; `socketEpoch` distinguishes instances
while each registered tap owns page-lifetime sequencing.

Core owns only the late-bound, transport-specific `YjsWireTap` and
`ThreadWireTap` contracts. The debug feature registers both implementations at
authenticated-route module evaluation, before either socket can be created;
runtime overlay enablement controls visibility, not capture. Separate tap
interfaces prevent thread strings from broadening the Yjs byte contract.
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
