# Phase 4: Dataset Domain

**Round 1** — Independent foundation. Dataset Upload UI (Phase 9) depends on this.

## Scope

Implement the dataset domain: interfaces, types, service, repository, handler, migration. DICOM file storage in Supabase with metadata in Postgres.

## Intent

Researchers need to upload DICOM image stacks. This phase builds the backend support — create dataset records, handle upload finalization, extract DICOM metadata, manage lifecycle.

## Files to Create

- `backend/internal/domain/datasets/interfaces.go` — Service + Repository interfaces
- `backend/internal/domain/datasets/types.go` — Dataset, DatasetStatus, DatasetMetadata, CreateDatasetRequest
- `backend/internal/service/datasets/dataset_service.go` — Service implementation
- `backend/internal/service/datasets/dataset_service_test.go` — Unit tests
- `backend/internal/repository/postgres/dataset.go` — Repository implementation
- `backend/internal/handler/dataset.go` — HTTP handler (CRUD + finalize)
- `backend/migrations/NNNNNN_create_datasets.up.sql`
- `backend/migrations/NNNNNN_create_datasets.down.sql`

## Files to Modify

- `backend/internal/app/domains/` — Add dataset domain wiring
- `backend/internal/handler/routes.go` — Register dataset endpoints

## Interface Contract

See `design/backend/dataset-domain.md` for full interface. Key methods:
- `Create(ctx, projectID, userID, req) → (*Dataset, error)`
- `FinalizeUpload(ctx, userID, datasetID) → error`
- `List(ctx, userID, projectID) → ([]Dataset, error)`
- `GetUploadURL(ctx, userID, datasetID, filename) → (string, error)`

## Patterns to Follow

- Domain: `backend/internal/domain/agents/` — interfaces + types
- Service: `backend/internal/service/` — existing services
- Handler: `backend/internal/handler/` — existing REST handlers
- Migration: `backend/migrations/AGENTS.md` — naming conventions

## Verification Criteria

- [ ] `make build` passes
- [ ] `make test` passes
- [ ] Migration applies cleanly
- [ ] HTTP endpoints respond correctly (create, list, finalize, delete)
- [ ] Authorization checks project membership

## Agent Staffing

- **Implementer**: `coder` (backend Go, CRUD domain)
- **Reviewer**: 1x reviewer (security — auth checks, storage access)
- **Verifier**: `verifier`
