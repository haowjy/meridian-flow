# WebSocket Migration — Deferred Items

Items cut from v1 implementation to reduce scope. All have GH issues. Build when triggered by real usage, not speculatively.

## Infrastructure (from YAGNI review p707)

| Item | Trigger | Issue |
|------|---------|-------|
| Byte-budget backpressure scheduler | Load testing shows memory pressure from large AG-UI events | [#41](https://github.com/haowjy/meridian/issues/41) |
| Per-user connection limits & registry | Multi-user access implemented | [#42](https://github.com/haowjy/meridian/issues/42) |
| Pre-auth DoS protection | Product publicly accessible | [#43](https://github.com/haowjy/meridian/issues/43) |
| Handler/StreamHandler ISP split | Third handler type or interface growth | [#44](https://github.com/haowjy/meridian/issues/44) |

## Security (from security review p702)

| Item | Trigger | Issue |
|------|---------|-------|
| Notify lane resource-level auth filtering | Auth model evolves beyond owner-only | [#45](https://github.com/haowjy/meridian/issues/45) |

## Observability (from requirements)

| Item | Trigger | Issue |
|------|---------|-------|
| WS connection/event metrics (Prometheus) | Real users, need dashboards | — |
| Distributed tracing | Complex debugging scenarios | — |
