---
detail: standard
audience: developer
---

# Stage 1: Local Bridge Skeleton (No Privileged Capabilities)

Goal: A safe, observable process the web app can connect to, with no local power yet.

## Deliverables

- Service skeleton (`local-bridge/` or similar):
  - `GET /health`
  - `GET /version`
  - `GET /events` (SSE, initially heartbeat only)
- Logging:
  - request IDs
  - structured logs

## Security (Still Minimal, But Correct)

- Bind to `127.0.0.1` only.
- CORS allowlist (configurable) but no privileged endpoints exist yet.
- Reject unknown routes with consistent error envelope.

## Stage Exit Criteria

- Web UI can detect bridge availability and display "Connected/Disconnected".

