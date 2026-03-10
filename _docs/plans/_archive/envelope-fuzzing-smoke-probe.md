---
detail: minimal
audience: developer
---

# Envelope Fuzzing Smoke Probe

**Status:** approved

## Goal

Add a collab smoke probe that authenticates, subscribes, completes the Yjs sync handshake, sends malformed or hostile binary envelopes, and verifies the websocket remains usable.

## Flow

```mermaid
flowchart LR
  A["Auth websocket"] --> B["Subscribe target doc"]
  B --> C["Complete Yjs sync handshake"]
  C --> D["Send malformed or hostile envelope"]
  D --> E["Send valid JSON command"]
  E --> F["Assert socket stays alive"]
```

## Deliverables

- `tests/smoke/collab/envelope/probe.go`
- `tests/smoke/collab/envelope/smoke.sh`
- Verification: `go vet tests/smoke/collab/envelope/probe.go`
