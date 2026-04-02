# Framework Smoke Tests

Tests for the generic wsutil framework — auth, heartbeat, rate limiting. These apply to both thread WS and doc WS.

Run these after modifying: `backend/internal/wsutil/ws.go`, auth.go, or protocol.go.

See `../CLAUDE.md` for setup and toy client usage.

## Tests

- `auth-and-heartbeat.md` — JWT auth, heartbeat re-auth cycle, revocation on membership loss
- `rate-limiting.md` — 30 msg/s inbound limit, flood behavior
