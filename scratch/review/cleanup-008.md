# Cleanup 008 - Replace Runtime `console.*` With `makeLogger`

- Category: Project conventions
- Files and locations:
  - `frontend/src/features/auth/hooks/useSupabaseSession.ts:36`
  - `frontend/src/core/supabase/client.ts:16`
  - `frontend/src/features/documents/hooks/useDocumentSync.ts:112`
  - `frontend/src/features/documents/hooks/documentContentDriver.ts:42`
  - `frontend/src/features/documents/components/BatchActionsBar.tsx:72`
  - `frontend/src/features/documents/components/DocumentTreeContainer.tsx:267`
  - `frontend/src/features/documents/components/DocumentTreeContainer.tsx:336`
  - `frontend/src/features/documents/components/DocumentTreeContainer.tsx:413`
  - `frontend/src/core/theme/useTheme.ts:161`
  - `frontend/src/core/cm6-collab/sync/runtime.ts:249`
  - `frontend/src/core/editor/codemirror/livePreview/shikiHighlighter.ts:105`
  - `frontend/src/core/editor/codemirror/livePreview/plugin.ts:205`
  - `frontend/src/core/editor/codemirror/livePreview/plugin.ts:223`

## What is wrong and why

Frontend guidance requires `makeLogger(...)` instead of direct `console.*`. These direct calls bypass centralized log-level control and namespace tagging, and can generate noisy output in dev flows.

Occurrence decisions:

- `frontend/src/features/auth/hooks/useSupabaseSession.ts:36` -> convert to logger (`error`), auth namespace.
- `frontend/src/core/supabase/client.ts:16` -> convert to logger (`warn`), supabase namespace.
- `frontend/src/features/documents/hooks/useDocumentSync.ts:112` -> convert to logger (`error`), sync namespace.
- `frontend/src/features/documents/hooks/documentContentDriver.ts:42` -> convert to logger (`warn`), content-driver namespace.
- `frontend/src/features/documents/components/BatchActionsBar.tsx:72` -> convert to logger (`error`), component namespace.
- `frontend/src/features/documents/components/DocumentTreeContainer.tsx:267` -> convert to logger (`error`), component namespace.
- `frontend/src/features/documents/components/DocumentTreeContainer.tsx:336` -> convert to logger (`error`), component namespace.
- `frontend/src/features/documents/components/DocumentTreeContainer.tsx:413` -> convert to logger (`error`), component namespace.
- `frontend/src/core/theme/useTheme.ts:161` -> convert to logger (`warn`), theme namespace.
- `frontend/src/core/cm6-collab/sync/runtime.ts:249` -> convert to logger (`warn`), collab-sync namespace.
- `frontend/src/core/editor/codemirror/livePreview/shikiHighlighter.ts:105` -> convert to logger (`warn`), live-preview namespace.
- `frontend/src/core/editor/codemirror/livePreview/plugin.ts:205` -> convert to logger (`warn`), live-preview namespace.
- `frontend/src/core/editor/codemirror/livePreview/plugin.ts:223` -> convert to logger (`warn`), live-preview namespace.

Keep raw (docs only, not runtime behavior):

- `frontend/src/core/hooks/useLatestRef.ts:14` -> keep raw `console.log` in JSDoc example.
- `frontend/src/core/hooks/useAbortController.ts:23` -> keep raw `console.error` in JSDoc example.

## Suggested fix

1. Import `makeLogger` and create one namespaced logger per file.
2. Replace each runtime `console.*` with `log.warn/error(...)` as above.
3. Leave comment-only example snippets unchanged.
