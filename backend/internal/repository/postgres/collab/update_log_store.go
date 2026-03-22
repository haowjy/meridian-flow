package collab

import (
	"context"
	"fmt"

	"meridian/internal/domain"
	collab "meridian/internal/domain/collab"
	"meridian/internal/repository/postgres"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresUpdateLogStore persists append-only Yjs updates.
type PostgresUpdateLogStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

// NewUpdateLogStore creates a new update-log store.
func NewUpdateLogStore(config *postgres.RepositoryConfig) collab.UpdateLogStore {
	return &PostgresUpdateLogStore{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// AppendUpdate inserts one append-only update row and returns its ID.
func (s *PostgresUpdateLogStore) AppendUpdate(
	ctx context.Context,
	docID string,
	update []byte,
	origin string,
	userID *string,
) (int64, error) {
	query := fmt.Sprintf(`
		INSERT INTO %s (document_id, update, origin, user_id)
		VALUES ($1, $2, $3, $4)
		RETURNING id
	`, s.tables.CollabDocumentUpdates)

	var id int64
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, docID, update, origin, userID).Scan(&id); err != nil {
		return 0, fmt.Errorf("append update: %w", err)
	}

	return id, nil
}

// LoadSinceCheckpoint returns latest checkpoint state plus all updates after it.
func (s *PostgresUpdateLogStore) LoadSinceCheckpoint(ctx context.Context, docID string) ([]byte, [][]byte, error) {
	executor := postgres.GetExecutor(ctx, s.pool)

	checkpointState, checkpointUpToID, found, err := loadLatestCheckpoint(
		ctx,
		executor,
		s.tables.CollabDocumentCheckpoints,
		docID,
	)
	if err != nil {
		return nil, nil, err
	}
	if !found {
		checkpointState = nil
		checkpointUpToID = 0
	}

	updateRows, err := loadUpdateRowsAfter(ctx, executor, s.tables.CollabDocumentUpdates, docID, checkpointUpToID)
	if err != nil {
		return nil, nil, err
	}

	updates := make([][]byte, 0, len(updateRows))
	for _, row := range updateRows {
		updates = append(updates, row.update)
	}

	return checkpointState, updates, nil
}

// CountUpdates returns number of update rows for one document.
func (s *PostgresUpdateLogStore) CountUpdates(ctx context.Context, docID string) (int64, error) {
	query := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s
		WHERE document_id = $1
	`, s.tables.CollabDocumentUpdates)

	var count int64
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, docID).Scan(&count); err != nil {
		return 0, fmt.Errorf("count updates: %w", err)
	}

	return count, nil
}

// DeleteUpTo deletes all updates up to and including cutoff ID.
func (s *PostgresUpdateLogStore) DeleteUpTo(ctx context.Context, docID string, cutoffID int64) error {
	query := fmt.Sprintf(`
		DELETE FROM %s
		WHERE document_id = $1
		  AND id <= $2
	`, s.tables.CollabDocumentUpdates)

	executor := postgres.GetExecutor(ctx, s.pool)
	if _, err := executor.Exec(ctx, query, docID, cutoffID); err != nil {
		return fmt.Errorf("delete updates up to cutoff: %w", err)
	}
	return nil
}

// GetLatestUpdateID returns the latest append-only update ID for a document.
func (s *PostgresUpdateLogStore) GetLatestUpdateID(ctx context.Context, docID string) (int64, error) {
	query := fmt.Sprintf(`
		SELECT id
		FROM %s
		WHERE document_id = $1
		ORDER BY id DESC
		LIMIT 1
	`, s.tables.CollabDocumentUpdates)

	var id int64
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, docID).Scan(&id); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return 0, domain.NewNotFoundError("document_update", fmt.Sprintf("no update rows for document %s", docID))
		}
		return 0, fmt.Errorf("get latest update id: %w", err)
	}

	return id, nil
}

// ListDocumentsWithMinUpdates returns doc IDs that meet compaction threshold.
func (s *PostgresUpdateLogStore) ListDocumentsWithMinUpdates(ctx context.Context, minUpdates int64) ([]string, error) {
	query := fmt.Sprintf(`
		SELECT document_id::text
		FROM %s
		GROUP BY document_id
		HAVING COUNT(*) >= $1
		ORDER BY MAX(id) ASC
	`, s.tables.CollabDocumentUpdates)

	executor := postgres.GetExecutor(ctx, s.pool)
	rows, err := executor.Query(ctx, query, minUpdates)
	if err != nil {
		return nil, fmt.Errorf("list documents with min updates: %w", err)
	}
	defer rows.Close()

	docIDs := make([]string, 0)
	for rows.Next() {
		var docID string
		if scanErr := rows.Scan(&docID); scanErr != nil {
			return nil, fmt.Errorf("scan compaction document id: %w", scanErr)
		}
		docIDs = append(docIDs, docID)
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		return nil, fmt.Errorf("iterate compaction document ids: %w", rowsErr)
	}

	return docIDs, nil
}

// GetNthOldestUpdateID returns the nth oldest update row ID.
func (s *PostgresUpdateLogStore) GetNthOldestUpdateID(ctx context.Context, docID string, n int64) (int64, error) {
	query := fmt.Sprintf(`
		SELECT id
		FROM %s
		WHERE document_id = $1
		ORDER BY id ASC
		OFFSET $2
		LIMIT 1
	`, s.tables.CollabDocumentUpdates)

	var id int64
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, docID, n-1).Scan(&id); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return 0, domain.NewNotFoundError(
				"document_update",
				fmt.Sprintf("document %s has fewer than %d updates", docID, n),
			)
		}
		return 0, fmt.Errorf("get nth oldest update id: %w", err)
	}

	return id, nil
}

// ListUpdatesInRange returns update rows ordered by ID where afterID < id <= upToID.
func (s *PostgresUpdateLogStore) ListUpdatesInRange(
	ctx context.Context,
	docID string,
	afterID int64,
	upToID int64,
) ([]collab.UpdateLogEntry, error) {
	updateRows, err := loadUpdateRowsInRange(
		ctx,
		postgres.GetExecutor(ctx, s.pool),
		s.tables.CollabDocumentUpdates,
		docID,
		afterID,
		upToID,
	)
	if err != nil {
		return nil, err
	}

	entries := make([]collab.UpdateLogEntry, 0, len(updateRows))
	for _, row := range updateRows {
		entries = append(entries, collab.UpdateLogEntry{
			ID:     row.id,
			Update: row.update,
		})
	}

	return entries, nil
}

// AcquireCompactionLock acquires a transaction-scoped advisory lock for one document.
func (s *PostgresUpdateLogStore) AcquireCompactionLock(ctx context.Context, docID string) error {
	query := `SELECT pg_advisory_xact_lock(hashtext($1))`

	executor := postgres.GetExecutor(ctx, s.pool)
	if _, err := executor.Exec(ctx, query, docID); err != nil {
		return fmt.Errorf("acquire compaction advisory lock: %w", err)
	}
	return nil
}
