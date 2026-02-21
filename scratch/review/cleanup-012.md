# Cleanup 012 - Adapter Conversion Failure During Unmount Save Is Silent

- Category: Reliability
- File and location: `frontend/src/features/documents/hooks/useDocumentSync.ts:190`

## What is wrong and why

The unmount/document-switch save path catches adapter conversion failures and silently falls back to raw content save. Fallback is correct for data preservation, but silent handling hides adapter bugs and makes debugging conversion regressions difficult.

## Suggested fix

1. Keep the fallback save behavior.
2. Add a structured `warn/error` log (via `makeLogger`) with document id + extension + conversion error context.
3. Optionally add a non-blocking metric/event for repeated conversion failures.
