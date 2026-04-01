# Phase 2: Dataset Domain

**Round 1** — Can run in parallel with Phase 1 (no dependency).

## Scope

Implement the dataset domain for DICOM stack upload and metadata management. New domain with interfaces, service, repository, handler, and migration.

## Intent

Researchers need to upload DICOM stacks before the agent can process them. This phase builds the backend plumbing: database schema, CRUD service, HTTP endpoints, and Supabase Storage integration. The frontend upload UI comes in Phase 6.

## Files to Create

- `backend/internal/domain/datasets/interfaces.go` — Service + Repository interfaces
- `backend/internal/domain/datasets/types.go` — Dataset, DatasetMetadata, DatasetStatus
- `backend/internal/service/datasets/service.go` — DatasetService implementation
- `backend/internal/service/datasets/service_test.go` — Unit tests
- `backend/internal/handler/dataset.go` — HTTP endpoints
- `backend/internal/repository/postgres/dataset.go` — DatasetRepository
- `backend/migrations/NNNNNN_create_datasets.up.sql`
- `backend/migrations/NNNNNN_create_datasets.down.sql`

## Files to Modify

- `backend/internal/app/domains/` — Add dataset domain wiring
- `backend/internal/handler/routes.go` (or equivalent) — Register dataset routes

## Interface Contract

```go
type Service interface {
    Create(ctx context.Context, projectID, userID uuid.UUID, req CreateDatasetRequest) (*Dataset, error)
    FinalizeUpload(ctx context.Context, datasetID uuid.UUID) error
    Get(ctx context.Context, datasetID uuid.UUID) (*Dataset, error)
    List(ctx context.Context, projectID uuid.UUID) ([]Dataset, error)
    GetBySlug(ctx context.Context, projectID uuid.UUID, slug string) (*Dataset, error)
    Delete(ctx context.Context, datasetID uuid.UUID) error
    GetStoragePath(ctx context.Context, datasetID uuid.UUID) (string, error)
}
```

## HTTP Endpoints

```
POST   /api/projects/{pid}/datasets          → Create
GET    /api/projects/{pid}/datasets          → List
GET    /api/datasets/{did}                   → Get
DELETE /api/datasets/{did}                   → Delete
POST   /api/datasets/{did}/finalize          → FinalizeUpload
```

## Dependencies

- Requires: None (independent foundation)
- Requires at finalize: Go DICOM parser (`github.com/suyashkumar/dicom`) for metadata extraction
- Independent of: Phase 1 (sandbox service)

## Patterns to Follow

- Handler: `backend/internal/handler/` (existing pattern with middleware auth)
- Authorization: Service layer checks `authorizer.CanAccessProject()` — see `backend/internal/service/docsystem/document.go`
- Migration: Follow `backend/migrations/AGENTS.md` rules
- Error responses: RFC 7807 via `httputil.RespondError()`

## Verification Criteria

- [ ] `make build` passes
- [ ] `make test` passes (service unit tests)
- [ ] Migration applies: `make migrate-up`
- [ ] `curl POST /api/projects/{pid}/datasets` creates a dataset record
- [ ] `curl GET /api/projects/{pid}/datasets` lists datasets
- [ ] `curl POST /api/datasets/{did}/finalize` extracts DICOM metadata from Supabase Storage

## Agent Staffing

- **Implementer**: `coder` (standard backend CRUD, well-established patterns)
- **Reviewer**: 1x reviewer (correctness focus — validate DICOM metadata extraction)
- **Verifier**: `verifier`
