---
detail: minimal
audience: developer
---
# Phase 1: Oplog + Transport

**Status:** In planning  
**Priority:** High  
**Purpose:** Replace snapshot PATCH saves with authoritative operation streaming.

## In Scope

- WebSocket ticket issuance/redeem flow.
- CM6 collab push/pull transport.
- Authoritative applied-operations schema and version allocation.
- Snapshot-first load + op catch-up contract.
- Error contract (`RESET_REQUIRED`, `TICKET_INVALID`, idempotency replay).

## Out of Scope

- AI proposal review UI.
- Multi-agent arbitration policies.
- Multi-user presence/cursors.

## Deliverables

- `collab_document_applied_operations` table + constraints (human edits + accepted AI edits).
- `collab_ws_tickets` table + one-time redemption.
- Node authority service (`Authority`, `DocumentSession`, WS handler).
- Frontend collab transport + extension wiring.
- Kill switch support (`COLLAB_DISABLED`).

## Dependencies

- Canonical architecture and security model from `_docs/plans/fb-realtime-collab-editing.md`.
- Storage invariants from `_docs/plans/collab-ai/spec/storage-model.md`.
- Transport/error contracts from `_docs/plans/collab-ai/spec/api-events-contract.md`.

## Implements Specs

- `_docs/plans/collab-ai/spec/storage-model.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`

## Exit Criteria

- Two concurrent clients can push edits without version collisions.
- Replayed `client_op_id` is idempotent (no duplicate applied ops).
- Reconnect from snapshot/op-floor works with explicit `RESET_REQUIRED`.
- Typing is allowed during reconnect (queued local ops flush on reconnect).

## Related

- `_docs/plans/fb-realtime-collab-editing.md`
- `_docs/plans/collab-ai/spec/storage-model.md`
- `_docs/plans/collab-ai/spec/api-events-contract.md`
