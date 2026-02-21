# Cleanup 009 - `DocumentTreeContainer` Violates SRP and File Size Rule

- Category: Architecture
- File and location: `frontend/src/features/documents/components/DocumentTreeContainer.tsx:1`

## What is wrong and why

`DocumentTreeContainer.tsx` is 964 lines and combines multiple domains in one component: tree loading, skills, project settings, dialog orchestration, import flows, inline create/rename, recursive rendering, and navigation side effects. This violates the project SRP rule (`<500` lines) and makes behavior changes high-risk.

## Suggested fix

Split by responsibility, for example:

1. Extract data/state orchestration hook(s) (`useDocumentTreeData`, `useTreeDialogs`).
2. Extract rendering helpers/components (`TreeRenderer`, `PendingItemRenderer`).
3. Keep `DocumentTreeContainer` as composition glue only.
4. Preserve current behavior with focused component tests around create/rename/delete/import and skill actions.
