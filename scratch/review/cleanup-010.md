# Cleanup 010 - Skill Delete Failure Is Console-Only (No User Feedback)

- Category: Reliability
- File and location: `frontend/src/features/documents/components/DocumentTreeContainer.tsx:413`

## What is wrong and why

When skill deletion fails, the code only logs to console and does not surface actionable feedback in UI. This makes failure silent for users and breaks consistency with the app's shared error-handling patterns.

## Suggested fix

1. Replace console-only handling with user-visible error handling (`handleApiError`, toast, or `InlineError` state).
2. Keep logging via `makeLogger` for diagnostics.
3. Ensure dialog state stays coherent on failure (e.g., keep dialog open with clear error state).
