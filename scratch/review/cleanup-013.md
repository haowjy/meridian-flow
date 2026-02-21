# Cleanup 013

- Category: Architecture (SRP)
- File: `frontend/src/core/stores/useThreadStore.ts:1`

## Issue
`useThreadStore.ts` is 1448 lines and mixes multiple responsibilities (thread list loading, turn pagination/navigation, streaming coordination, interjection flows, stream-end waiter lifecycle).

## Why it matters
This violates the project SRP/file-size rule (<500 lines) and makes changes high-risk: unrelated behaviors are tightly coupled in one store.

## Suggested fix
Split into focused modules/stores (e.g., `threadList`, `turnWindow/navigation`, `streamCoordination/interjection`) and keep orchestration thin at the boundary.
