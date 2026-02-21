# Cleanup 014

- Category: Reliability
- File: `frontend/src/features/documents/hooks/useDocumentSync.ts:129`
- Issue: `documentSyncService.save(...)` is fired inside the debounce timer without `await`/`.catch(...)` and without `void` + explicit error handling.
- Why this is a problem: `DocumentSyncService.save` can reject on non-network failures (validation/4xx). In this path that rejection is unhandled, producing noisy unhandled promise rejections and skipping consistent UI error handling.
- Suggested fix:
1. Wrap the debounced save call with `void documentSyncService.save(...).catch(...)`.
2. Route failure through existing error handling (store error state and/or `handleApiError`) to keep behavior consistent.
3. Add a test for rejected save in debounced mode to assert no unhandled rejection.
