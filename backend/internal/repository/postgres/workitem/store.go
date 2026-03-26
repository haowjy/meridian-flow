package workitem

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	domainwi "meridian/internal/domain/workitem"
	"meridian/internal/repository/postgres"
)

// PostgresWorkItemStore implements domainwi.Store using PostgreSQL.
type PostgresWorkItemStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
	logger *slog.Logger
}

// Compile-time interface check.
var _ domainwi.Store = (*PostgresWorkItemStore)(nil)

// NewWorkItemStore creates a new PostgresWorkItemStore.
func NewWorkItemStore(config *postgres.RepositoryConfig) domainwi.Store {
	return &PostgresWorkItemStore{
		pool:   config.Pool,
		tables: config.Tables,
		logger: config.Logger,
	}
}

// workItemColumns lists all columns returned by a full work-item SELECT.
const workItemColumns = `id, project_id, user_id, name, slug, description,
	status, is_ephemeral, metadata, created_at, updated_at, deleted_at`

// scanWorkItem scans a pgx row into a WorkItem.
func scanWorkItem(row interface {
	Scan(dest ...any) error
}, wi *domainwi.WorkItem) error {
	return row.Scan(
		&wi.ID,
		&wi.ProjectID,
		&wi.UserID,
		&wi.Name,
		&wi.Slug,
		&wi.Description,
		&wi.Status,
		&wi.IsEphemeral,
		&wi.Metadata,
		&wi.CreatedAt,
		&wi.UpdatedAt,
		&wi.DeletedAt,
	)
}

// Create inserts a new work item row.
// The caller must supply a valid slug; Create returns domain.ErrConflict if the
// partial unique index (project_id, slug) WHERE deleted_at IS NULL is violated.
func (r *PostgresWorkItemStore) Create(ctx context.Context, item *domainwi.WorkItem) error {
	if item.Metadata == nil {
		item.Metadata = map[string]interface{}{}
	}

	query := fmt.Sprintf(`
		INSERT INTO %s (
			project_id, user_id, name, slug, description,
			status, is_ephemeral, metadata, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING %s
	`, r.tables.WorkItems, workItemColumns)

	executor := postgres.GetExecutor(ctx, r.pool)
	err := scanWorkItem(executor.QueryRow(ctx, query,
		item.ProjectID,
		item.UserID,
		item.Name,
		item.Slug,
		item.Description,
		string(item.Status),
		item.IsEphemeral,
		item.Metadata,
		item.CreatedAt,
		item.UpdatedAt,
	), item)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			return domain.NewConflictError("work_item", item.Slug,
				fmt.Sprintf("work item with slug %q already exists in this project", item.Slug))
		}
		if postgres.IsPgCheckConstraintError(err) {
			return domain.NewValidationError(fmt.Sprintf("work item slug %q is not valid", item.Slug))
		}
		return fmt.Errorf("create work item: %w", err)
	}

	return nil
}

// GetByID returns a non-deleted work item by UUID.
func (r *PostgresWorkItemStore) GetByID(ctx context.Context, id string) (*domainwi.WorkItem, error) {
	query := fmt.Sprintf(`
		SELECT %s FROM %s
		WHERE id = $1 AND deleted_at IS NULL
	`, workItemColumns, r.tables.WorkItems)

	executor := postgres.GetExecutor(ctx, r.pool)
	var wi domainwi.WorkItem
	err := scanWorkItem(executor.QueryRow(ctx, query, id), &wi)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("work_item", fmt.Sprintf("work item %s not found", id))
		}
		return nil, fmt.Errorf("get work item by id: %w", err)
	}

	return &wi, nil
}

// GetBySlug returns a non-deleted work item by project + slug.
func (r *PostgresWorkItemStore) GetBySlug(ctx context.Context, projectID, slug string) (*domainwi.WorkItem, error) {
	query := fmt.Sprintf(`
		SELECT %s FROM %s
		WHERE project_id = $1 AND slug = $2 AND deleted_at IS NULL
	`, workItemColumns, r.tables.WorkItems)

	executor := postgres.GetExecutor(ctx, r.pool)
	var wi domainwi.WorkItem
	err := scanWorkItem(executor.QueryRow(ctx, query, projectID, slug), &wi)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("work_item",
				fmt.Sprintf("work item %q not found in project %s", slug, projectID))
		}
		return nil, fmt.Errorf("get work item by slug: %w", err)
	}

	return &wi, nil
}

// ListByProject returns a page of non-deleted work items, ordered by
// created_at DESC then id DESC for stable pagination.
// Returns (items, totalCount, error).
func (r *PostgresWorkItemStore) ListByProject(ctx context.Context, projectID string, offset, limit int) ([]domainwi.WorkItem, int, error) {
	executor := postgres.GetExecutor(ctx, r.pool)

	// Separate count query — avoids window function overhead on small pages
	// and keeps scanning simpler.
	countQuery := fmt.Sprintf(`
		SELECT COUNT(*) FROM %s
		WHERE project_id = $1 AND deleted_at IS NULL
	`, r.tables.WorkItems)

	var total int
	if err := executor.QueryRow(ctx, countQuery, projectID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count work items: %w", err)
	}

	if total == 0 {
		return []domainwi.WorkItem{}, 0, nil
	}

	listQuery := fmt.Sprintf(`
		SELECT %s FROM %s
		WHERE project_id = $1 AND deleted_at IS NULL
		ORDER BY created_at DESC, id DESC
		LIMIT $2 OFFSET $3
	`, workItemColumns, r.tables.WorkItems)

	rows, err := executor.Query(ctx, listQuery, projectID, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list work items: %w", err)
	}
	defer rows.Close()

	items := make([]domainwi.WorkItem, 0, limit)
	for rows.Next() {
		var wi domainwi.WorkItem
		if err := scanWorkItem(rows, &wi); err != nil {
			return nil, 0, fmt.Errorf("scan work item: %w", err)
		}
		items = append(items, wi)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate work items: %w", err)
	}

	return items, total, nil
}

// Update persists the mutable fields (name, description, metadata).
// updated_at is managed by a DB trigger, so we RETURNING it to keep the
// caller's struct in sync with the actual persisted value.
// Slug and status are not updated here — use UpdateStatus for status changes.
func (r *PostgresWorkItemStore) Update(ctx context.Context, item *domainwi.WorkItem) error {
	if item.Metadata == nil {
		item.Metadata = map[string]interface{}{}
	}

	query := fmt.Sprintf(`
		UPDATE %s
		SET name = $1, description = $2, metadata = $3
		WHERE id = $4 AND deleted_at IS NULL
		RETURNING updated_at
	`, r.tables.WorkItems)

	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query,
		item.Name,
		item.Description,
		item.Metadata,
		item.ID,
	).Scan(&item.UpdatedAt)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return domain.NewNotFoundError("work_item", fmt.Sprintf("work item %s not found", item.ID))
		}
		return fmt.Errorf("update work item: %w", err)
	}

	return nil
}

// UpdateStatus atomically sets status from `from` to `to`.
// The CAS-style WHERE status = $from prevents lost-update races.
// updated_at is managed by the DB trigger; no need to pass it here.
func (r *PostgresWorkItemStore) UpdateStatus(ctx context.Context, id string, from, to domainwi.Status) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET status = $1
		WHERE id = $2 AND status = $3 AND deleted_at IS NULL
	`, r.tables.WorkItems)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, string(to), id, string(from))
	if err != nil {
		return fmt.Errorf("update work item status: %w", err)
	}

	if result.RowsAffected() == 0 {
		// Distinguish "not found" from "wrong current status" by checking existence.
		exists, existsErr := r.exists(ctx, id)
		if existsErr != nil {
			return existsErr
		}
		if !exists {
			return domain.NewNotFoundError("work_item", fmt.Sprintf("work item %s not found", id))
		}
		// Row exists but current status != from — concurrent modification.
		return domain.NewConflictError("work_item", id,
			fmt.Sprintf("work item %s status transition from %q failed: unexpected current status", id, from))
	}

	return nil
}

// SoftDelete sets deleted_at, hiding the item from all default queries.
// updated_at is managed by the DB trigger; we only set deleted_at explicitly.
func (r *PostgresWorkItemStore) SoftDelete(ctx context.Context, id string, deletedAt time.Time) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET deleted_at = $1
		WHERE id = $2 AND deleted_at IS NULL
	`, r.tables.WorkItems)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, deletedAt, id)
	if err != nil {
		return fmt.Errorf("soft delete work item: %w", err)
	}
	if result.RowsAffected() == 0 {
		return domain.NewNotFoundError("work_item", fmt.Sprintf("work item %s not found", id))
	}

	return nil
}

// AttachThread sets threads.work_item_id for the given thread.
func (r *PostgresWorkItemStore) AttachThread(ctx context.Context, threadID, workItemID string) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET work_item_id = $1, updated_at = NOW()
		WHERE id = $2 AND deleted_at IS NULL
	`, r.tables.Threads)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, workItemID, threadID)
	if err != nil {
		if postgres.IsPgForeignKeyError(err) {
			return domain.NewNotFoundError("work_item",
				fmt.Sprintf("work item %s not found", workItemID))
		}
		return fmt.Errorf("attach thread %s to work item %s: %w", threadID, workItemID, err)
	}
	if result.RowsAffected() == 0 {
		return domain.NewNotFoundError("thread", fmt.Sprintf("thread %s not found", threadID))
	}

	return nil
}

// threadSummaryColumns lists the columns we select for ThreadSummary.
const threadSummaryColumns = `id, project_id, user_id, title, work_item_id,
	created_at, updated_at, deleted_at`

func scanThreadSummary(row interface {
	Scan(dest ...any) error
}, ts *domainwi.ThreadSummary) error {
	return row.Scan(
		&ts.ID,
		&ts.ProjectID,
		&ts.UserID,
		&ts.Title,
		&ts.WorkItemID,
		&ts.CreatedAt,
		&ts.UpdatedAt,
		&ts.DeletedAt,
	)
}

// ListThreads returns a page of non-deleted threads attached to a work item,
// ordered by updated_at DESC then id DESC.
func (r *PostgresWorkItemStore) ListThreads(ctx context.Context, workItemID string, offset, limit int) ([]domainwi.ThreadSummary, int, error) {
	executor := postgres.GetExecutor(ctx, r.pool)

	countQuery := fmt.Sprintf(`
		SELECT COUNT(*) FROM %s
		WHERE work_item_id = $1 AND deleted_at IS NULL
	`, r.tables.Threads)

	var total int
	if err := executor.QueryRow(ctx, countQuery, workItemID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count threads for work item: %w", err)
	}

	if total == 0 {
		return []domainwi.ThreadSummary{}, 0, nil
	}

	listQuery := fmt.Sprintf(`
		SELECT %s FROM %s
		WHERE work_item_id = $1 AND deleted_at IS NULL
		ORDER BY updated_at DESC, id DESC
		LIMIT $2 OFFSET $3
	`, threadSummaryColumns, r.tables.Threads)

	rows, err := executor.Query(ctx, listQuery, workItemID, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list threads for work item: %w", err)
	}
	defer rows.Close()

	summaries := make([]domainwi.ThreadSummary, 0, limit)
	for rows.Next() {
		var ts domainwi.ThreadSummary
		if err := scanThreadSummary(rows, &ts); err != nil {
			return nil, 0, fmt.Errorf("scan thread summary: %w", err)
		}
		summaries = append(summaries, ts)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate thread summaries: %w", err)
	}

	return summaries, total, nil
}

// HasStreamingThreads reports whether any turn currently in 'streaming' status
// is attached to a thread that belongs to the given work item.
// Called by the service layer before allowing Complete to proceed.
func (r *PostgresWorkItemStore) HasStreamingThreads(ctx context.Context, workItemID string) (bool, error) {
	query := fmt.Sprintf(`
		SELECT EXISTS(
			SELECT 1
			FROM %s t
			JOIN %s th ON t.thread_id = th.id
			WHERE th.work_item_id = $1
			  AND th.deleted_at IS NULL
			  AND t.status = 'streaming'
		)
	`, r.tables.Turns, r.tables.Threads)

	var hasStreaming bool
	executor := postgres.GetExecutor(ctx, r.pool)
	if err := executor.QueryRow(ctx, query, workItemID).Scan(&hasStreaming); err != nil {
		return false, fmt.Errorf("check streaming threads for work item %s: %w", workItemID, err)
	}

	return hasStreaming, nil
}

// CountAttachedThreads returns the number of non-deleted threads attached to
// the given work item.
func (r *PostgresWorkItemStore) CountAttachedThreads(ctx context.Context, workItemID string) (int, error) {
	query := fmt.Sprintf(`
		SELECT COUNT(*) FROM %s
		WHERE work_item_id = $1 AND deleted_at IS NULL
	`, r.tables.Threads)

	var count int
	executor := postgres.GetExecutor(ctx, r.pool)
	if err := executor.QueryRow(ctx, query, workItemID).Scan(&count); err != nil {
		return 0, fmt.Errorf("count attached threads for work item %s: %w", workItemID, err)
	}

	return count, nil
}

// CountActiveEphemerals returns the number of non-deleted, active, ephemeral
// work items for the project. Used to enforce the per-project cap of 100.
func (r *PostgresWorkItemStore) CountActiveEphemerals(ctx context.Context, projectID string) (int, error) {
	query := fmt.Sprintf(`
		SELECT COUNT(*) FROM %s
		WHERE project_id = $1
		  AND is_ephemeral = true
		  AND status = 'active'
		  AND deleted_at IS NULL
	`, r.tables.WorkItems)

	var count int
	executor := postgres.GetExecutor(ctx, r.pool)
	if err := executor.QueryRow(ctx, query, projectID).Scan(&count); err != nil {
		return 0, fmt.Errorf("count active ephemerals for project %s: %w", projectID, err)
	}

	return count, nil
}

// GetMostRecentActiveEphemeral returns the most recently created non-deleted, active,
// ephemeral work item for the project. Used by EnsureThreadWorkItem when the cap is reached.
// Returns domain.ErrNotFound if no such work item exists.
func (r *PostgresWorkItemStore) GetMostRecentActiveEphemeral(ctx context.Context, projectID string) (*domainwi.WorkItem, error) {
	query := fmt.Sprintf(`
		SELECT %s FROM %s
		WHERE project_id = $1
		  AND is_ephemeral = true
		  AND status = 'active'
		  AND deleted_at IS NULL
		ORDER BY created_at DESC, id DESC
		LIMIT 1
	`, workItemColumns, r.tables.WorkItems)

	executor := postgres.GetExecutor(ctx, r.pool)
	var wi domainwi.WorkItem
	err := scanWorkItem(executor.QueryRow(ctx, query, projectID), &wi)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("work_item",
				fmt.Sprintf("no active ephemeral work items in project %s", projectID))
		}
		return nil, fmt.Errorf("get most recent active ephemeral for project %s: %w", projectID, err)
	}

	return &wi, nil
}

// exists is an internal helper that checks whether a non-deleted work item row
// exists — used to distinguish not-found from wrong-status in UpdateStatus.
// Excluding soft-deleted rows prevents misclassifying a deleted item as a
// CAS conflict (ConflictError) when it should be a NotFoundError.
func (r *PostgresWorkItemStore) exists(ctx context.Context, id string) (bool, error) {
	query := fmt.Sprintf(`
		SELECT EXISTS(SELECT 1 FROM %s WHERE id = $1 AND deleted_at IS NULL)
	`, r.tables.WorkItems)

	var exists bool
	executor := postgres.GetExecutor(ctx, r.pool)
	if err := executor.QueryRow(ctx, query, id).Scan(&exists); err != nil {
		return false, fmt.Errorf("check work item exists: %w", err)
	}

	return exists, nil
}
