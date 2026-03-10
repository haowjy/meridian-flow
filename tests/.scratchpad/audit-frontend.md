# Audit: Frontend Stores, Hooks & API (gpt-5.4, p27)

## HIGH

- **Tree refresh skips after create** `useTreeStore.ts` — `loadTree()` skips refreshes for 30s, but `createDocument()`, `createFolder()`, and `createFolderByPath()` call it without invalidating `treeLoadedAt`, so freshly created items can stay invisible until some later invalidation.

- **Concurrent 401 handling is lossy** `api.ts` — The first request refreshes the session; simultaneous requests return `false` immediately from `handleUnauthorized()` and fail instead of waiting for the in-flight refresh.

- **SSE streaming bypasses token refresh** `useSSEConnection.ts`, `api.ts` — The SSE streaming path bypasses `fetchAPI()` token refresh and also disables `fetch-event-source` retries by rethrowing from `onerror()`. Transient 401, 429, or 5xx conditions terminate streaming instead of reconnecting.

## MEDIUM

- **Autosave bypasses editor error UI** `useDocumentSync.ts`, `useEditorStore.ts` — Normal autosave path calls `documentSyncService.save()` directly without awaiting/catching and without routing through `useEditorStore.saveDocument()`. Validation/permanent failures surface as unhandled promise rejections, and the editor save status/error UI is bypassed.

- **activeThreadId not cleared on project switch** `useUIStore.ts`, `WorkspaceLayout.tsx` — `activeThreadId` is persisted globally and not cleared on project switch, so a stale thread from the previous project can be loaded/rendered until later reconciliation.

- **409 conflict payloads not camelCased** `api.ts` — `fetchAPI()` camel-cases successful JSON, but 409 conflict `resource` payloads are copied through untouched. `AppError.resource` can have snake_case fields while success payloads are camelCase.

## LOW

- **Proposal count badge stale after update** `useProjectCollab.ts`, `useTreeStore.ts`, `treeBuilder.ts` — Collab proposal-count updates mutate `documents` only; the rendered tree uses materialized `TreeNode.data`, so document badges can stay stale until a full tree rebuild.
