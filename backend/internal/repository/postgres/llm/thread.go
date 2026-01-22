package llm

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"meridian/internal/domain"
	llmModels "meridian/internal/domain/models/llm"
	llmRepo "meridian/internal/domain/repositories/llm"
	"meridian/internal/repository/postgres"
)

// PostgresThreadRepository implements the ThreadRepository interface using PostgreSQL
type PostgresThreadRepository struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
	logger *slog.Logger
}

// NewThreadRepository creates a new PostgresThreadRepository
func NewThreadRepository(config *postgres.RepositoryConfig) llmRepo.ThreadRepository {
	return &PostgresThreadRepository{
		pool:   config.Pool,
		tables: config.Tables,
		logger: config.Logger,
	}
}

// CreateThread creates a new thread session
func (r *PostgresThreadRepository) CreateThread(ctx context.Context, thread *llmModels.Thread) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (project_id, user_id, title, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at, updated_at
	`, r.tables.Threads)

	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query,
		thread.ProjectID,
		thread.UserID,
		thread.Title,
		thread.CreatedAt,
		thread.UpdatedAt,
	).Scan(&thread.ID, &thread.CreatedAt, &thread.UpdatedAt)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			// Query for existing thread to get its ID
			existingID, queryErr := r.getExistingThreadID(ctx, thread.ProjectID, thread.UserID, thread.Title)
			if queryErr != nil {
				return fmt.Errorf("thread '%s' already exists: %w", thread.Title, domain.ErrConflict)
			}

			return &domain.ConflictError{
				Message:      fmt.Sprintf("thread '%s' already exists", thread.Title),
				ResourceType: "thread",
				ResourceID:   existingID,
			}
		}
		return fmt.Errorf("create thread: %w", err)
	}

	return nil
}

// getExistingThreadID retrieves the ID of an existing thread
func (r *PostgresThreadRepository) getExistingThreadID(ctx context.Context, projectID, userID, title string) (string, error) {
	query := fmt.Sprintf(`
		SELECT id FROM %s
		WHERE project_id = $1 AND user_id = $2 AND title = $3 AND deleted_at IS NULL
	`, r.tables.Threads)

	var id string
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, projectID, userID, title).Scan(&id)
	if err != nil {
		return "", err
	}

	return id, nil
}

// GetThread retrieves a thread by ID (scoped to user)
func (r *PostgresThreadRepository) GetThread(ctx context.Context, threadID, userID string) (*llmModels.Thread, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, user_id, title, system_prompt, last_viewed_turn_id, created_at, updated_at, deleted_at
		FROM %s
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
	`, r.tables.Threads)

	var thread llmModels.Thread
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, threadID, userID).Scan(
		&thread.ID,
		&thread.ProjectID,
		&thread.UserID,
		&thread.Title,
		&thread.SystemPrompt,
		&thread.LastViewedTurnID,
		&thread.CreatedAt,
		&thread.UpdatedAt,
		&thread.DeletedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("thread %s: %w", threadID, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("get thread: %w", err)
	}

	return &thread, nil
}

// GetThreadByIDOnly retrieves a thread by UUID only (no user scoping)
// Used by ResourceAuthorizer when authorization is handled separately
func (r *PostgresThreadRepository) GetThreadByIDOnly(ctx context.Context, threadID string) (*llmModels.Thread, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, user_id, title, system_prompt, last_viewed_turn_id, created_at, updated_at, deleted_at
		FROM %s
		WHERE id = $1 AND deleted_at IS NULL
	`, r.tables.Threads)

	var thread llmModels.Thread
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, threadID).Scan(
		&thread.ID,
		&thread.ProjectID,
		&thread.UserID,
		&thread.Title,
		&thread.SystemPrompt,
		&thread.LastViewedTurnID,
		&thread.CreatedAt,
		&thread.UpdatedAt,
		&thread.DeletedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("thread %s: %w", threadID, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("get thread: %w", err)
	}

	return &thread, nil
}

// ListThreadsByProject retrieves all threads for a project
func (r *PostgresThreadRepository) ListThreadsByProject(ctx context.Context, projectID, userID string) ([]llmModels.Thread, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, user_id, title, system_prompt, last_viewed_turn_id, created_at, updated_at, deleted_at
		FROM %s
		WHERE project_id = $1 AND user_id = $2 AND deleted_at IS NULL
		ORDER BY updated_at DESC
	`, r.tables.Threads)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, projectID, userID)
	if err != nil {
		return nil, fmt.Errorf("list threads: %w", err)
	}
	defer rows.Close()

	var threads []llmModels.Thread
	for rows.Next() {
		var thread llmModels.Thread
		err := rows.Scan(
			&thread.ID,
			&thread.ProjectID,
			&thread.UserID,
			&thread.Title,
			&thread.SystemPrompt,
			&thread.LastViewedTurnID,
			&thread.CreatedAt,
			&thread.UpdatedAt,
			&thread.DeletedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan thread: %w", err)
		}
		threads = append(threads, thread)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate threads: %w", err)
	}

	// Return empty slice instead of nil
	if threads == nil {
		threads = []llmModels.Thread{}
	}

	return threads, nil
}

// UpdateThread updates a thread's mutable fields
func (r *PostgresThreadRepository) UpdateThread(ctx context.Context, thread *llmModels.Thread) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET title = $1, system_prompt = $2, last_viewed_turn_id = $3, updated_at = $4
		WHERE id = $5 AND user_id = $6 AND deleted_at IS NULL
	`, r.tables.Threads)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query,
		thread.Title,
		thread.SystemPrompt,
		thread.LastViewedTurnID,
		thread.UpdatedAt,
		thread.ID,
		thread.UserID,
	)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			existingID, queryErr := r.getExistingThreadID(ctx, thread.ProjectID, thread.UserID, thread.Title)
			if queryErr != nil {
				return fmt.Errorf("thread '%s' already exists: %w", thread.Title, domain.ErrConflict)
			}

			return &domain.ConflictError{
				Message:      fmt.Sprintf("thread '%s' already exists", thread.Title),
				ResourceType: "thread",
				ResourceID:   existingID,
			}
		}
		return fmt.Errorf("update thread: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("thread %s: %w", thread.ID, domain.ErrNotFound)
	}

	return nil
}

// UpdateLastViewedTurn updates only the last_viewed_turn_id field
// Validates that the turn belongs to the thread before updating (single query)
func (r *PostgresThreadRepository) UpdateLastViewedTurn(ctx context.Context, threadID, userID, turnID string) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET last_viewed_turn_id = $1, updated_at = $2
		WHERE id = $3
		  AND user_id = $4
		  AND deleted_at IS NULL
		  AND EXISTS (
		    SELECT 1 FROM %s
		    WHERE id = $1 AND thread_id = $3
		  )
	`, r.tables.Threads, r.tables.Turns)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query,
		turnID,
		time.Now(),
		threadID,
		userID,
	)

	if err != nil {
		return fmt.Errorf("update last_viewed_turn_id: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("thread %s: %w", threadID, domain.ErrNotFound)
	}

	return nil
}

// DeleteThread soft-deletes a thread
func (r *PostgresThreadRepository) DeleteThread(ctx context.Context, threadID, userID string) (*llmModels.Thread, error) {
	query := fmt.Sprintf(`
		UPDATE %s
		SET deleted_at = NOW()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING id, project_id, user_id, title, system_prompt, last_viewed_turn_id, created_at, updated_at, deleted_at
	`, r.tables.Threads)

	executor := postgres.GetExecutor(ctx, r.pool)
	row := executor.QueryRow(ctx, query, threadID, userID)

	var thread llmModels.Thread
	err := row.Scan(
		&thread.ID,
		&thread.ProjectID,
		&thread.UserID,
		&thread.Title,
		&thread.SystemPrompt,
		&thread.LastViewedTurnID,
		&thread.CreatedAt,
		&thread.UpdatedAt,
		&thread.DeletedAt,
	)
	if err != nil {
		if err.Error() == "no rows in result set" {
			return nil, fmt.Errorf("thread %s: %w", threadID, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("delete thread: %w", err)
	}

	return &thread, nil
}

// GetThreadTree retrieves the lightweight tree structure for cache validation
func (r *PostgresThreadRepository) GetThreadTree(ctx context.Context, threadID, userID string) (*llmModels.ThreadTree, error) {
	// First verify thread exists and user has access
	threadQuery := fmt.Sprintf(`
		SELECT updated_at
		FROM %s
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
	`, r.tables.Threads)

	executor := postgres.GetExecutor(ctx, r.pool)

	var updatedAt time.Time
	err := executor.QueryRow(ctx, threadQuery, threadID, userID).Scan(&updatedAt)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("thread %s: %w", threadID, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("get thread for tree: %w", err)
	}

	// Get all turns for this thread (just IDs and parent relationships)
	// Uses depth-first traversal order (visit all descendants before siblings)
	// NOTE: This is a DEBUG endpoint - production should use pagination with sibling_ids
	turnsQuery := fmt.Sprintf(`
		WITH RECURSIVE dfs AS (
			-- Base case: root nodes (no parent)
			SELECT
				id,
				prev_turn_id,
				ARRAY[created_at::text, id::text] as sort_path,
				0 as depth
			FROM %s
			WHERE thread_id = $1 AND prev_turn_id IS NULL

			UNION ALL

			-- Recursive case: children (depth-first traversal)
			SELECT
				t.id,
				t.prev_turn_id,
				dfs.sort_path || ARRAY[t.created_at::text, t.id::text],
				dfs.depth + 1
			FROM %s t
			INNER JOIN dfs ON t.prev_turn_id = dfs.id
			WHERE dfs.depth < 1000  -- Prevent infinite recursion
		)
		SELECT id, prev_turn_id
		FROM dfs
		ORDER BY sort_path
	`, r.tables.Turns, r.tables.Turns)

	rows, err := executor.Query(ctx, turnsQuery, threadID)
	if err != nil {
		return nil, fmt.Errorf("get turns for tree: %w", err)
	}
	defer rows.Close()

	var nodes []llmModels.TurnTreeNode
	for rows.Next() {
		var node llmModels.TurnTreeNode
		err := rows.Scan(&node.ID, &node.PrevTurnID)
		if err != nil {
			return nil, fmt.Errorf("scan turn node: %w", err)
		}
		nodes = append(nodes, node)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate turn nodes: %w", err)
	}

	// Return empty slice if no turns (not nil)
	if nodes == nil {
		nodes = []llmModels.TurnTreeNode{}
	}

	return &llmModels.ThreadTree{
		Turns:     nodes,
		UpdatedAt: updatedAt,
	}, nil
}
