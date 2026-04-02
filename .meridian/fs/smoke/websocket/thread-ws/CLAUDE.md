# Thread WS Smoke Tests

Tests for `/ws/projects/{projectId}/threads` — AG-UI streaming, interjections, stream switch, spawn discovery.

Run these after modifying: `thread_ws_handler.go`, `interjection_forwarder.go`, `stream_executor.go`, `tool_executor.go`, `completion_handler.go`, or the frontend `StreamingChannelClient`.

See `../CLAUDE.md` for setup and toy client usage.

## Tests

- `streaming-lifecycle.md` — connect → auth → subscribe → receive events → ended
- `interjection.md` — send interjection, queued vs created modes
- `stream-switch.md` — interjection at tool boundary → switch → auto-follow successor
- `spawn-discovery.md` — spawn_started notify → auto-subscribe to spawn turn
