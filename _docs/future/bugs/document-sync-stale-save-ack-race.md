---
detail: minimal
audience: developer
---

# Document sync stale save-ack race (false conflict + autosave stall)

## Summary

When a save request returned after the user had already typed more, the old server snapshot could still be published into `activeDocument`. That snapshot was then interpreted as a competing server update while local edits were dirty, which created a false `pendingServerSnapshot` conflict and blocked autosave.

## Trigger Sequence

1. User types (dirty=true), debounce schedules save A.
2. Save A starts; user types again (newer local state).
3. Save A response arrives with older content.
4. Older snapshot updates `activeDocument`.
5. Content hook sees "server update while dirty" and sets `pendingServerSnapshot`.
6. Autosave effect exits early because conflict is pending.

## Impact

- Editor could get stuck in a "conflict pending" state without a real remote conflict.
- New local edits stopped autosaving until another state transition cleared the flag.

## Root Cause

Acknowledgements were not gated by local edit version. Any successful save response was treated as current, even when it was stale relative to in-flight local edits.

## Fix

- Capture `saveVersion` at save initiation.
- On save acknowledgement:
  - If `editVersionRef.current !== saveVersion`, treat ack as stale and skip publishing stale content.
  - For merged saves, still refresh CAS refs for future saves.

See:
- `frontend/src/features/documents/hooks/useDocumentSync.ts`

## Status

Fixed on branch `h/at-ref` (February 2026).
