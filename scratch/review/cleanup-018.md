# Cleanup 018

- Category: Dead code & Complexity
- File: `frontend/src/core/lib/sync.ts:28`, `frontend/src/core/components/SyncProvider.tsx:27`
- Issue: The in-memory retry scheduler is still initialized even though document retries now use `pendingDocumentSaves` + `persistentSaveDrain`.
- Why this is a problem: Unused background machinery increases cognitive load, adds startup noise/logging, and creates two conceptual retry systems in parallel.
- Suggested fix:
1. Remove unused scheduler lifecycle from `SyncProvider`.
2. Delete/trim dead APIs in `sync.ts` (`initializeRetryProcessor`, `cleanupRetryProcessor`, unused scheduler state).
3. Keep only direct sync primitives actually used by `DocumentSyncService` + drains.
