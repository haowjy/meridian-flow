package collab

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
	"meridian/internal/repository/postgres"
)

// PostgresDocumentStore persists Yjs binary state and derived content projections.
type PostgresDocumentStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
	logger *slog.Logger
}

// NewDocumentStore creates a service-scoped document store.
func NewDocumentStore(config *postgres.RepositoryConfig) collabSvc.DocumentStore {
	return &PostgresDocumentStore{
		pool:   config.Pool,
		tables: config.Tables,
		logger: config.Logger,
	}
}

// LoadState loads persisted Yjs state from documents.yjs_state.
func (s *PostgresDocumentStore) LoadState(ctx context.Context, docID string) ([]byte, error) {
	query := fmt.Sprintf(`
		SELECT yjs_state
		FROM %s
		WHERE id = $1 AND deleted_at IS NULL
	`, s.tables.Documents)

	var state []byte
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, docID).Scan(&state); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("document", fmt.Sprintf("document %s not found", docID))
		}
		return nil, fmt.Errorf("load yjs state: %w", err)
	}

	// NULL is valid pre-cutover data. Return empty state so caller can initialize Y.Doc.
	if state == nil {
		return []byte{}, nil
	}
	return state, nil
}

// SaveState persists Yjs state and both derived text projections in one UPDATE statement.
func (s *PostgresDocumentStore) SaveState(
	ctx context.Context,
	docID string,
	state []byte,
	content string,
	aiContent string,
) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET yjs_state = $1, content = $2, ai_content = $3
		WHERE id = $4 AND deleted_at IS NULL
	`, s.tables.Documents)

	executor := postgres.GetExecutor(ctx, s.pool)
	cmdTag, err := executor.Exec(ctx, query, state, content, aiContent, docID)
	if err != nil {
		return fmt.Errorf("save yjs state: %w", err)
	}

	if cmdTag.RowsAffected() == 0 {
		return domain.NewNotFoundError("document", fmt.Sprintf("document %s not found", docID))
	}
	return nil
}

// SaveSnapshot persists a restore/history point for collab document state.
func (s *PostgresDocumentStore) SaveSnapshot(
	ctx context.Context,
	docID string,
	state []byte,
	snapshotType string,
	name *string,
	createdByUserID *string,
) (string, error) {
	query := fmt.Sprintf(`
		INSERT INTO %s (document_id, yjs_state, snapshot_type, name, created_by_user_id)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id
	`, s.tables.CollabDocumentSnapshots)

	var id string
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, docID, state, snapshotType, name, createdByUserID).Scan(&id); err != nil {
		return "", fmt.Errorf("save collab snapshot: %w", err)
	}

	return id, nil
}

// ListSnapshots returns paginated snapshots for a document, newest first.
func (s *PostgresDocumentStore) ListSnapshots(ctx context.Context, docID string, limit, offset int) ([]collabModels.Snapshot, int, error) {
	countQuery := fmt.Sprintf(`
		SELECT COUNT(*) FROM %s WHERE document_id = $1
	`, s.tables.CollabDocumentSnapshots)

	executor := postgres.GetExecutor(ctx, s.pool)
	var total int
	if err := executor.QueryRow(ctx, countQuery, docID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count collab snapshots: %w", err)
	}

	if total == 0 {
		return []collabModels.Snapshot{}, 0, nil
	}

	query := fmt.Sprintf(`
		SELECT id, document_id, snapshot_type, name, created_by_user_id, created_at
		FROM %s
		WHERE document_id = $1
		ORDER BY created_at DESC
		LIMIT $2 OFFSET $3
	`, s.tables.CollabDocumentSnapshots)

	rows, err := executor.Query(ctx, query, docID, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list collab snapshots: %w", err)
	}
	defer rows.Close()

	var snapshots []collabModels.Snapshot
	for rows.Next() {
		var snap collabModels.Snapshot
		if err := rows.Scan(&snap.ID, &snap.DocumentID, &snap.SnapshotType, &snap.Name, &snap.CreatedByUserID, &snap.CreatedAt); err != nil {
			return nil, 0, fmt.Errorf("scan collab snapshot: %w", err)
		}
		snapshots = append(snapshots, snap)
	}

	return snapshots, total, nil
}

// GetSnapshot retrieves a single snapshot with its binary Yjs state.
func (s *PostgresDocumentStore) GetSnapshot(ctx context.Context, snapshotID string) (*collabModels.SnapshotWithState, error) {
	query := fmt.Sprintf(`
		SELECT id, document_id, yjs_state, snapshot_type, name, created_by_user_id, created_at
		FROM %s
		WHERE id = $1
	`, s.tables.CollabDocumentSnapshots)

	var snap collabModels.SnapshotWithState
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, snapshotID).Scan(
		&snap.ID, &snap.DocumentID, &snap.YjsState,
		&snap.SnapshotType, &snap.Name, &snap.CreatedByUserID, &snap.CreatedAt,
	); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("snapshot", fmt.Sprintf("snapshot %s not found", snapshotID))
		}
		return nil, fmt.Errorf("get collab snapshot: %w", err)
	}

	return &snap, nil
}

// DeleteSnapshot removes a single snapshot by ID.
func (s *PostgresDocumentStore) DeleteSnapshot(ctx context.Context, snapshotID string) error {
	query := fmt.Sprintf(`
		DELETE FROM %s WHERE id = $1
	`, s.tables.CollabDocumentSnapshots)

	executor := postgres.GetExecutor(ctx, s.pool)
	cmdTag, err := executor.Exec(ctx, query, snapshotID)
	if err != nil {
		return fmt.Errorf("delete collab snapshot: %w", err)
	}

	if cmdTag.RowsAffected() == 0 {
		return domain.NewNotFoundError("snapshot", fmt.Sprintf("snapshot %s not found", snapshotID))
	}
	return nil
}

// DeleteExpiredAutoSnapshots removes auto snapshots older than the given TTL.
func (s *PostgresDocumentStore) DeleteExpiredAutoSnapshots(ctx context.Context, ttlHours int) (int64, error) {
	query := fmt.Sprintf(`
		DELETE FROM %s
		WHERE snapshot_type = 'auto'
		  AND created_at < NOW() - INTERVAL '1 hour' * $1
	`, s.tables.CollabDocumentSnapshots)

	executor := postgres.GetExecutor(ctx, s.pool)
	cmdTag, err := executor.Exec(ctx, query, ttlHours)
	if err != nil {
		return 0, fmt.Errorf("delete expired auto snapshots: %w", err)
	}
	return cmdTag.RowsAffected(), nil
}
