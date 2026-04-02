# Phase 7: Dataset Upload UI (v2)

**Round 3** — Depends on Phase 2 (backend API) and Phase 5 (frontend infrastructure). Can run in parallel with Phase 6.

## Scope

Frontend components in `frontend-v2/` for DICOM stack upload: drag-and-drop zone, upload progress, dataset list with metadata display. Connects to the dataset API endpoints from Phase 2 and uses the dataset store from Phase 5.

## Intent

The researcher needs to upload DICOM files before analysis can begin. This provides the drag-and-drop interface, parallel file upload to Supabase Storage, and dataset management (list, view metadata, delete).

## Files to Create

- `frontend-v2/src/features/datasets/DatasetPanel.tsx` + `.stories.tsx`
- `frontend-v2/src/features/datasets/DatasetUploadZone.tsx` + `.stories.tsx`
- `frontend-v2/src/features/datasets/DatasetList.tsx`
- `frontend-v2/src/features/datasets/DatasetCard.tsx` + `.stories.tsx`
- `frontend-v2/src/features/datasets/DatasetMetadataView.tsx`
- `frontend-v2/src/features/datasets/hooks/useDatasetUpload.ts` — Upload orchestration
- `frontend-v2/src/features/datasets/hooks/useDatasets.ts` — TanStack Query hooks
- `frontend-v2/src/features/datasets/types.ts` — Dataset, DatasetMetadata types
- `frontend-v2/src/features/datasets/index.ts`
- `frontend-v2/src/features/datasets/examples/mock-datasets.ts` — Storybook mocks

## Files to Modify

- `frontend-v2/src/features/workspace/ContentPanel.tsx` — Import and render DatasetPanel
- `frontend-v2/src/stores/dataset-store.ts` — May need adjustments based on implementation

## Dependencies

- Requires: Phase 2 (dataset API endpoints)
- Requires: Phase 5 (workspace store, dataset store, API client, ContentPanel)
- Independent of: Phase 1, 3, 4, 6
- Consumed by: The agent reads datasets from sandbox after hydration

## Key Implementation Details

1. **Parallel upload**: Max 5 concurrent file uploads to Supabase Storage
2. **File validation**: Client-side check for .dcm extension (MVP; DICOM magic bytes deferred)
3. **Progress tracking**: Dataset store tracks per-upload progress, UI shows file count and bytes
4. **Finalize**: After all files uploaded, call `/api/datasets/{id}/finalize` for metadata extraction
5. **TanStack Query**: Dataset list auto-refetches; mutations invalidate the query key

## Patterns to Follow

- Feature module: `frontend-v2/src/features/` pattern with co-located stories
- Data fetching: TanStack Query (see `@tanstack/react-query` already in package.json)
- Components: shadcn/ui primitives (Button, Badge, Progress)
- Upload: Direct to Supabase Storage using authenticated fetch
- Mock data: Shared factories in `examples/mock-datasets.ts`

## Design Docs

- [Dataset Upload](../../design/frontend/dataset-upload.md)
- [State Management](../../design/frontend/state.md) — dataset store + TanStack Query hooks

## Verification Criteria

- [ ] `pnpm run build` passes
- [ ] `pnpm run lint` passes
- [ ] Drag-and-drop zone accepts .dcm files
- [ ] Upload progress shows file count and byte progress
- [ ] Dataset list displays after upload with metadata
- [ ] Delete removes dataset from list
- [ ] All upload states render correctly (idle, uploading, processing, complete, error)
- [ ] Storybook stories for DatasetUploadZone, DatasetCard, DatasetPanel

## Agent Staffing

- **Implementer**: `frontend-coder` (React + upload orchestration)
- **Reviewer**: 1x reviewer (UX focus — upload edge cases, progress feedback, error handling)
- **Verifier**: `verifier`
