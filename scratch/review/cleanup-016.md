# Cleanup 016

- Category: Reliability
- File: `frontend/src/core/lib/panelHelpers.ts:39`
- Issue: `decodeDocumentPath` directly calls `decodeURIComponent` (twice) without malformed-input guards.
- Why this is a problem: A malformed `%` sequence in URL path throws `URIError`, which can break route resolution and panel navigation.
- Suggested fix:
1. Add a safe decode helper with `try/catch`.
2. On decode failure, return the raw segment/path and log once at `warn` level.
3. Add tests for malformed encoded paths (`%`, `%E0%A4%A`) and legacy double-encoded paths.
