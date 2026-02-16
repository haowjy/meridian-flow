package collab

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	collabRepo "meridian/internal/domain/repositories/collab"
	collabSvc "meridian/internal/domain/services/collab"
	"meridian/internal/repository/postgres"
)

// PostgresDocumentStore persists Yjs binary state and derived content projections.
type PostgresDocumentStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
	logger *slog.Logger
}

// NewDocumentStoreRepository creates a repository-scoped document store.
func NewDocumentStoreRepository(config *postgres.RepositoryConfig) collabRepo.DocumentStoreRepository {
	return &PostgresDocumentStore{
		pool:   config.Pool,
		tables: config.Tables,
		logger: config.Logger,
	}
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
) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (document_id, yjs_state, snapshot_type, name, created_by_user_id)
		VALUES ($1, $2, $3, $4, $5)
	`, s.tables.CollabDocumentSnapshots)

	executor := postgres.GetExecutor(ctx, s.pool)
	if _, err := executor.Exec(ctx, query, docID, state, snapshotType, name, createdByUserID); err != nil {
		return fmt.Errorf("save collab snapshot: %w", err)
	}

	return nil
}
