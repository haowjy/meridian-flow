# Cleanup 020

- Category: Architecture (SRP)
- File: `frontend/src/features/documents/hooks/useProjectCollab.ts:1`
- Issue: File is 779 lines (>500 rule) and combines transport state machine, reconnect policy, message parsing/routing, type guards, token resolution, URL building, and React hook wrapper.
- Why this is a problem: Transport behavior is hard to reason about and test in isolation; high coupling makes protocol changes risky.
- Suggested fix:
1. Extract a transport module (`projectCollabTransport.ts`) with pure helpers (URL/token/normalizers).
2. Move event type guards/parsers into dedicated protocol files.
3. Keep `useProjectCollab` as a thin lifecycle wrapper around transport creation/start/stop.
