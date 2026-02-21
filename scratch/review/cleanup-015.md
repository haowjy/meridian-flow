# Cleanup 015

- Category: Correctness
- File: `frontend/src/features/documents/hooks/useInlineReview.ts:286`
- Issue: `handleAcceptAll` closes proposals and clears review state even if one or more `applyChunkUpdate` calls fail (`ok === false`).
- Why this is a problem: Failed chunk applications are silently dropped, but the proposal is still rejected/closed and UI state is cleared. This can lose intended accepted edits and desync local review state from backend proposal state.
- Suggested fix:
1. Track per-chunk apply failures in `handleAcceptAll`.
2. Only finalize/clear when all pending chunks successfully apply.
3. Keep failed chunks visible and surface a warning/toast so users can retry.
