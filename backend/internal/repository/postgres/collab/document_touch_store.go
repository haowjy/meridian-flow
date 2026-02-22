package collab

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
	"meridian/internal/repository/postgres"
)

// PostgresDocumentTouchStore records document-turn provenance.
type PostgresDocumentTouchStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
	logger *slog.Logger
}

// NewDocumentTouchStore creates a new document touch store.
func NewDocumentTouchStore(config *postgres.RepositoryConfig) collabSvc.DocumentTouchStore {
	return &PostgresDocumentTouchStore{
		pool:   config.Pool,
		tables: config.Tables,
		logger: config.Logger,
	}
}

// RecordTouch inserts a touch record, ignoring duplicates (upsert on unique index).
func (s *PostgresDocumentTouchStore) RecordTouch(ctx context.Context, documentID, threadID, turnID string) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (document_id, thread_id, turn_id)
		VALUES ($1, $2, $3)
		ON CONFLICT (turn_id, document_id) DO NOTHING
	`, s.tables.TurnDocumentTouches)

	executor := postgres.GetExecutor(ctx, s.pool)
	if _, err := executor.Exec(ctx, query, documentID, threadID, turnID); err != nil {
		return fmt.Errorf("record document touch: %w", err)
	}
	return nil
}

// ListByDocument returns touches for a document, newest first.
func (s *PostgresDocumentTouchStore) ListByDocument(ctx context.Context, documentID string, limit, offset int) ([]collabModels.DocumentTouch, error) {
	query := fmt.Sprintf(`
		SELECT id, document_id, thread_id, turn_id, touched_at
		FROM %s
		WHERE document_id = $1
		ORDER BY touched_at DESC
		LIMIT $2 OFFSET $3
	`, s.tables.TurnDocumentTouches)

	executor := postgres.GetExecutor(ctx, s.pool)
	rows, err := executor.Query(ctx, query, documentID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("list touches by document: %w", err)
	}
	defer rows.Close()

	var touches []collabModels.DocumentTouch
	for rows.Next() {
		var t collabModels.DocumentTouch
		if err := rows.Scan(&t.ID, &t.DocumentID, &t.ThreadID, &t.TurnID, &t.TouchedAt); err != nil {
			return nil, fmt.Errorf("scan document touch: %w", err)
		}
		touches = append(touches, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list touches by document: row iteration: %w", err)
	}
	return touches, nil
}

// ListByTurn returns all documents touched by a specific turn.
func (s *PostgresDocumentTouchStore) ListByTurn(ctx context.Context, turnID string) ([]collabModels.DocumentTouch, error) {
	query := fmt.Sprintf(`
		SELECT id, document_id, thread_id, turn_id, touched_at
		FROM %s
		WHERE turn_id = $1
		ORDER BY touched_at ASC
	`, s.tables.TurnDocumentTouches)

	executor := postgres.GetExecutor(ctx, s.pool)
	rows, err := executor.Query(ctx, query, turnID)
	if err != nil {
		return nil, fmt.Errorf("list touches by turn: %w", err)
	}
	defer rows.Close()

	var touches []collabModels.DocumentTouch
	for rows.Next() {
		var t collabModels.DocumentTouch
		if err := rows.Scan(&t.ID, &t.DocumentID, &t.ThreadID, &t.TurnID, &t.TouchedAt); err != nil {
			return nil, fmt.Errorf("scan document touch: %w", err)
		}
		touches = append(touches, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list touches by turn: row iteration: %w", err)
	}
	return touches, nil
}
