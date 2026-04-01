# Phase 6: Dataset Upload UI

**Round 3** — Depends on Phase 2 (backend endpoints). Can run in parallel with Phase 5.

## Scope

Frontend components for DICOM stack upload: drag-and-drop zone, upload progress, dataset list with metadata display. Connects to the dataset API endpoints from Phase 2.

## Intent

The researcher needs to upload DICOM files before analysis can begin. This provides the drag-and-drop interface, parallel file upload to Supabase Storage, and dataset management (list, view metadata, delete).

## Files to Create

- `frontend/src/features/datasets/DatasetPanel.tsx` — Main panel (list + upload)
- `frontend/src/features/datasets/DatasetUploadZone.tsx` — Drag-and-drop zone
- `frontend/src/features/datasets/DatasetList.tsx` — List view
- `frontend/src/features/datasets/DatasetCard.tsx` — Individual dataset card
- `frontend/src/features/datasets/DatasetMetadataView.tsx` — Expanded metadata
- `frontend/src/features/datasets/hooks/useDatasetUpload.ts` — Upload state machine
- `frontend/src/features/datasets/hooks/useDatasets.ts` — TanStack Query hooks
- `frontend/src/features/datasets/types.ts` — TypeScript types

## Files to Modify

- `frontend/src/features/documents/components/DocumentPanel.tsx` — Add dataset panel as content type option
- `frontend/src/core/stores/` (or UI store) — Add dataset-related state

## Dependencies

- Requires: Phase 2 (dataset API endpoints must exist)
- Independent of: Phase 1, 3, 4, 5
- Consumed by: The agent reads datasets from sandbox after hydration

## Key Implementation Details

1. **Parallel upload**: Max 5 concurrent file uploads to Supabase Storage
2. **File validation**: Client-side check for .dcm extension or DICOM magic bytes (128-byte preamble + "DICM")
3. **Progress tracking**: Per-file and aggregate progress with cancel support
4. **Finalize**: After all files uploaded, call `/api/datasets/{id}/finalize` to trigger metadata extraction

## Patterns to Follow

- Feature organization: `frontend/src/features/` (existing feature module pattern)
- Data fetching: TanStack Query (see existing query patterns in the codebase)
- Components: shadcn/ui primitives (Button, Badge, Progress, Dialog)
- Upload: Supabase Storage client for direct-to-storage uploads

## Verification Criteria

- [ ] `pnpm run build` passes
- [ ] `pnpm run lint` passes
- [ ] Drag-and-drop zone accepts .dcm files
- [ ] Upload progress shows file count and byte progress
- [ ] Dataset list displays after upload with metadata
- [ ] Delete removes dataset from list and storage
- [ ] Storybook stories for DatasetUploadZone, DatasetCard

## Agent Staffing

- **Implementer**: `frontend-coder` (React + Supabase Storage upload pattern)
- **Reviewer**: 1x reviewer (UX focus — upload edge cases, progress feedback)
- **Verifier**: `verifier`
