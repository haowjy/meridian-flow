# Phase A4a: Work Item Domain + Migration + Store

## Scope
Create the work_items table, thread FK, domain types, interfaces, and Postgres store with full CRUD + thread attachment.

## Intent
Work items are foundational for v1 — everything from agent tools to spawning depends on them. This creates the persistence and domain layer.

## Files to Create
- `backend/migrations/00034_create_work_items.sql` — work_items table with all indexes
- `backend/migrations/00035_add_work_item_id_to_threads.sql` — nullable FK on threads
- `backend/internal/domain/workitem/types.go` — WorkItem, WorkItemStatus, ThreadSummary types
- `backend/internal/domain/workitem/interfaces.go` — Service + Store interfaces
- `backend/internal/repository/postgres/workitem/store.go` — Postgres store implementation
- `backend/internal/repository/postgres/workitem/store_test.go` — Integration tests

## Schema: work_items table
```sql
CREATE TABLE work_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id),
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',  -- active, done, deleted
    ephemeral BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ
);

-- Partial unique: no duplicate active slugs per project
CREATE UNIQUE INDEX idx_work_items_project_slug_active
    ON work_items(project_id, slug)
    WHERE status != 'deleted';

CREATE INDEX idx_work_items_project_status ON work_items(project_id, status);
```

Thread FK migration:
```sql
ALTER TABLE chats ADD COLUMN work_item_id UUID REFERENCES work_items(id);
CREATE INDEX idx_chats_work_item_id ON chats(work_item_id);
```

## Store Methods
- Create(ctx, workItem) (*WorkItem, error)
- GetByID(ctx, id, userID) (*WorkItem, error)
- GetBySlug(ctx, projectID, slug) (*WorkItem, error)
- ListByProject(ctx, projectID, offset, limit) ([]WorkItem, int, error) — with total count
- Update(ctx, workItem) (*WorkItem, error)
- UpdateStatus(ctx, id, status) error
- SoftDelete(ctx, id) error
- AttachThread(ctx, threadID, workItemID) error
- ListThreads(ctx, workItemID, offset, limit) ([]ThreadSummary, int, error) — returns workitem-local DTO
- HasStreamingThreads(ctx, workItemID) (bool, error)
- CountAttachedThreads(ctx, workItemID) (int, error)
- CountActiveEphemerals(ctx, projectID) (int, error) — for cap enforcement

## ThreadSummary DTO
```go
type ThreadSummary struct {
    ID        string
    Title     string
    CreatedAt time.Time
    UpdatedAt time.Time
    Persona   *string
}
```

This is a workitem-local DTO — NOT domain/llm.Thread. Avoids cross-domain coupling.

## Key Constraints
- Per-project ephemeral cap: max 100 active ephemeral work items. Enforce in CountActiveEphemerals.
- Partial unique index prevents duplicate active slugs per project
- Soft delete: set status='deleted', deleted_at=now(). Do NOT hard delete.
- ListByProject returns offset/limit pagination (not cursor-based)

## Patterns to Follow
- See `backend/internal/repository/postgres/llm/thread_store.go` for existing Postgres store pattern
- See `backend/internal/domain/llm/thread.go` for domain type conventions
- See `backend/migrations/` for migration file naming (sequential numbers)
- Run `scripts/lint-migrations.sh` to validate migration SQL

## Verification Criteria
- [ ] `make migrate-up` succeeds (or manual psql apply)
- [ ] `make test` passes
- [ ] Store CRUD integration tests pass
- [ ] Offset/limit pagination returns correct order
- [ ] Partial unique index prevents duplicate active slugs
- [ ] `scripts/lint-migrations.sh` passes on new migrations
- [ ] CountActiveEphemerals returns correct count
- [ ] ListThreads returns ThreadSummary, not llm.Thread
- [ ] `go vet ./...` clean
