---
detail: standard
audience: developer
---

# Stage 8: Desktop Reuse (Bridge as Backbone)

Goal: Make the bridge a reusable headless core so a future desktop app is packaging + UX, not a rewrite.

## Backbone Contract

- Stable API surface for:
  - mounts + fs sync
  - exec tools
  - local LLM streaming
- All policy/security lives in the bridge, not the UI.

## Desktop Bundle Strategy

- Desktop app bundles the same bridge binary and manages:
  - start/stop lifecycle
  - pairing UX
  - updates
  - OS integrations (tray, notifications)

Future (optional):
- Replace loopback HTTP with IPC without changing bridge core logic (keep internal interfaces transport-agnostic).

## Stage Exit Criteria

- Bridge is headless, embeddable, and has no web-only assumptions baked into core logic.

