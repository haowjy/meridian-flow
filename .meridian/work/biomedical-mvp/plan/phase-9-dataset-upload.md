# Phase 9: Dataset Upload UI

**Round 3** — Requires Phase 4 (backend endpoints) + Phase 6 (layout, stores, API client).

## Scope

Build the dataset upload interface: drag-and-drop zone, progress tracking, dataset list, dataset cards. Wire to backend endpoints via API client.

## Intent

Researchers need to upload DICOM stacks. This phase builds the frontend: file validation, parallel upload, progress display, and dataset browsing.

## Files to Create

- `frontend-v2/src/features/datasets/DatasetPanel.tsx`
- `frontend-v2/src/features/datasets/DatasetUploadZone.tsx`
- `frontend-v2/src/features/datasets/DatasetList.tsx`
- `frontend-v2/src/features/datasets/DatasetCard.tsx`
- `frontend-v2/src/features/datasets/hooks/useDatasets.ts` — TanStack Query hooks
- `frontend-v2/src/features/datasets/hooks/useDatasetUpload.ts` — Upload orchestration
- Stories for each component

## Files to Modify

- `frontend-v2/src/features/workspace/ContentPanel.tsx` — Replace dataset stub with DatasetPanel

## Dependencies

- Requires: Phase 4 (backend dataset endpoints)
- Requires: Phase 6 (API client, dataset store, workspace layout)

## Verification Criteria

- [ ] `pnpm run lint` passes
- [ ] Storybook: DatasetUploadZone renders drag-and-drop area
- [ ] Storybook: DatasetCard shows metadata
- [ ] Upload hook: validates file extensions
- [ ] Upload hook: tracks progress via dataset store
- [ ] Error handling: upload failures set store error state

## Agent Staffing

- **Implementer**: `frontend-coder`
- **Verifier**: `verifier`
