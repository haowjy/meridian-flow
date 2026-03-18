package collab

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	"meridian/internal/repository/postgres"
)

// PostgresDocumentStore persists collab document state and checkpoints.
type PostgresDocumentStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

// NewDocumentStore creates a service-scoped document store.
// Returns the concrete type so callers can use it as DocumentStateStore,
// CheckpointStore, and DocumentContentLoader.
func NewDocumentStore(config *postgres.RepositoryConfig) *PostgresDocumentStore {
	return &PostgresDocumentStore{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// LoadState reconstructs state from latest checkpoint + append-only updates.
func (s *PostgresDocumentStore) LoadState(ctx context.Context, docID string) ([]byte, error) {
	executor := postgres.GetExecutor(ctx, s.pool)

	checkpointState, checkpointUpToID, found, err := loadLatestCheckpoint(
		ctx,
		executor,
		s.tables.CollabDocumentCheckpoints,
		docID,
	)
	if err != nil {
		return nil, err
	}
	if !found {
		checkpointState = nil
		checkpointUpToID = 0
	}

	updateRows, err := loadUpdateRowsAfter(ctx, executor, s.tables.CollabDocumentUpdates, docID, checkpointUpToID)
	if err != nil {
		return nil, err
	}

	if len(checkpointState) == 0 && len(updateRows) == 0 {
		existsQuery := fmt.Sprintf(`
			SELECT 1
			FROM %s
			WHERE id = $1 AND deleted_at IS NULL
		`, s.tables.Documents)
		var exists int
		if err := executor.QueryRow(ctx, existsQuery, docID).Scan(&exists); err != nil {
			if postgres.IsPgNoRowsError(err) {
				return nil, domain.NewNotFoundError("document", fmt.Sprintf("document %s not found", docID))
			}
			return nil, fmt.Errorf("verify document for empty replay state: %w", err)
		}
		return []byte{}, nil
	}

	updates := make([][]byte, 0, len(updateRows))
	for _, row := range updateRows {
		updates = append(updates, row.update)
	}

	doc, err := applyStateAndUpdates(docID, checkpointState, updates)
	if err != nil {
		return nil, err
	}
	return encodeDocState(doc)
}

// LoadContentForBootstrap loads markdown content when server-side Yjs bootstrap is needed.
func (s *PostgresDocumentStore) LoadContentForBootstrap(ctx context.Context, docID string) (string, error) {
	query := fmt.Sprintf(`
		SELECT content
		FROM %s
		WHERE id = $1 AND deleted_at IS NULL
	`, s.tables.Documents)

	var content *string
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, docID).Scan(&content); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return "", domain.NewNotFoundError("document", fmt.Sprintf("document %s not found", docID))
		}
		return "", fmt.Errorf("load bootstrap content: %w", err)
	}

	if content == nil {
		return "", nil
	}

	return *content, nil
}

// SaveState persists derived text projections. The state argument is retained for
// temporary interface compatibility during migration, but is no longer written to documents.
func (s *PostgresDocumentStore) SaveState(
	ctx context.Context,
	docID string,
	_ []byte,
	content string,
) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET content = $1
		WHERE id = $2 AND deleted_at IS NULL
	`, s.tables.Documents)

	executor := postgres.GetExecutor(ctx, s.pool)
	cmdTag, err := executor.Exec(ctx, query, content, docID)
	if err != nil {
		return fmt.Errorf("save document content projections: %w", err)
	}

	if cmdTag.RowsAffected() == 0 {
		return domain.NewNotFoundError("document", fmt.Sprintf("document %s not found", docID))
	}
	return nil
}

// GetLatest loads the most recent checkpoint for one document.
func (s *PostgresDocumentStore) GetLatest(ctx context.Context, docID string) ([]byte, int64, error) {
	query := fmt.Sprintf(`
		SELECT state, up_to_id
		FROM %s
		WHERE document_id = $1
		ORDER BY id DESC
		LIMIT 1
	`, s.tables.CollabDocumentCheckpoints)

	var state []byte
	var upToID int64
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, docID).Scan(&state, &upToID); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, 0, nil
		}
		return nil, 0, fmt.Errorf("get latest checkpoint: %w", err)
	}

	return state, upToID, nil
}

// Create inserts a new checkpoint row.
func (s *PostgresDocumentStore) Create(ctx context.Context, docID string, state []byte, upToID int64) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (document_id, state, up_to_id)
		VALUES ($1, $2, $3)
	`, s.tables.CollabDocumentCheckpoints)

	executor := postgres.GetExecutor(ctx, s.pool)
	if _, err := executor.Exec(ctx, query, docID, state, upToID); err != nil {
		return fmt.Errorf("create checkpoint: %w", err)
	}

	return nil
}
