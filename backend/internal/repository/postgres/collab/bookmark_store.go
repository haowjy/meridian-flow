package collab

import (
	"context"
	"fmt"

	"meridian/internal/domain"
	collab "meridian/internal/domain/collab"
	"meridian/internal/repository/postgres"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresBookmarkStore persists collab document bookmarks.
type PostgresBookmarkStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

// NewBookmarkStore creates a new bookmark store.
func NewBookmarkStore(config *postgres.RepositoryConfig) collab.BookmarkStore {
	return &PostgresBookmarkStore{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// Create inserts a bookmark and ignores duplicate (document_id, turn_id, bookmark_type).
func (s *PostgresBookmarkStore) Create(ctx context.Context, bookmark *collab.Bookmark) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (
			document_id, update_id, state, bookmark_type, turn_id, name, created_by
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (document_id, turn_id, bookmark_type) DO NOTHING
		RETURNING id, created_at
	`, s.tables.CollabDocumentBookmarks)

	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(
		ctx,
		query,
		bookmark.DocumentID,
		bookmark.UpdateID,
		bookmark.State,
		bookmark.BookmarkType,
		bookmark.TurnID,
		bookmark.Name,
		bookmark.CreatedBy,
	).Scan(&bookmark.ID, &bookmark.CreatedAt); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil
		}
		return fmt.Errorf("create bookmark: %w", err)
	}

	return nil
}

// ListByDocumentAndType returns bookmarks by type for one document.
func (s *PostgresBookmarkStore) ListByDocumentAndType(
	ctx context.Context,
	docID string,
	bookmarkType string,
) ([]collab.Bookmark, error) {
	query := fmt.Sprintf(`
		SELECT id, document_id, update_id, state, bookmark_type, turn_id, name, created_by, created_at
		FROM %s
		WHERE document_id = $1
		  AND bookmark_type = $2
		ORDER BY created_at DESC, id DESC
	`, s.tables.CollabDocumentBookmarks)

	executor := postgres.GetExecutor(ctx, s.pool)
	rows, err := executor.Query(ctx, query, docID, bookmarkType)
	if err != nil {
		return nil, fmt.Errorf("list bookmarks by document and type: %w", err)
	}
	defer rows.Close()

	return scanBookmarks(rows)
}

// ListByTurnID returns bookmarks linked to one turn.
func (s *PostgresBookmarkStore) ListByTurnID(ctx context.Context, turnID string) ([]collab.Bookmark, error) {
	query := fmt.Sprintf(`
		SELECT id, document_id, update_id, state, bookmark_type, turn_id, name, created_by, created_at
		FROM %s
		WHERE turn_id = $1
		ORDER BY created_at ASC, id ASC
	`, s.tables.CollabDocumentBookmarks)

	executor := postgres.GetExecutor(ctx, s.pool)
	rows, err := executor.Query(ctx, query, turnID)
	if err != nil {
		return nil, fmt.Errorf("list bookmarks by turn id: %w", err)
	}
	defer rows.Close()

	return scanBookmarks(rows)
}

// GetState resolves a bookmark to state bytes.
// If the bookmark points to update_id (state NULL), it reconstructs via checkpoint + replay.
func (s *PostgresBookmarkStore) GetState(ctx context.Context, bookmarkID string) ([]byte, error) {
	query := fmt.Sprintf(`
		SELECT document_id, update_id, state
		FROM %s
		WHERE id = $1
	`, s.tables.CollabDocumentBookmarks)

	var docID string
	var updateID *int64
	var state []byte
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, bookmarkID).Scan(&docID, &updateID, &state); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("bookmark", fmt.Sprintf("bookmark %s not found", bookmarkID))
		}
		return nil, fmt.Errorf("get bookmark state: %w", err)
	}

	if len(state) > 0 {
		return state, nil
	}
	if updateID == nil {
		return nil, domain.NewNotFoundError("bookmark_state", fmt.Sprintf("bookmark %s has no resolvable state", bookmarkID))
	}

	return loadStateAtUpdateID(
		ctx,
		executor,
		s.tables.CollabDocumentCheckpoints,
		s.tables.CollabDocumentUpdates,
		docID,
		*updateID,
	)
}

// MaterializeState sets state and clears update_id.
func (s *PostgresBookmarkStore) MaterializeState(ctx context.Context, bookmarkID string, state []byte) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET state = $2, update_id = NULL
		WHERE id = $1
	`, s.tables.CollabDocumentBookmarks)

	executor := postgres.GetExecutor(ctx, s.pool)
	tag, err := executor.Exec(ctx, query, bookmarkID, state)
	if err != nil {
		return fmt.Errorf("materialize bookmark state: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return domain.NewNotFoundError("bookmark", fmt.Sprintf("bookmark %s not found", bookmarkID))
	}

	return nil
}

// DeleteByTypeAndCutoff deletes pointer bookmarks of one type within compaction cutoff.
func (s *PostgresBookmarkStore) DeleteByTypeAndCutoff(
	ctx context.Context,
	docID string,
	bookmarkType string,
	cutoffUpdateID int64,
) error {
	query := fmt.Sprintf(`
		DELETE FROM %s
		WHERE document_id = $1
		  AND bookmark_type = $2
		  AND update_id IS NOT NULL
		  AND update_id <= $3
	`, s.tables.CollabDocumentBookmarks)

	executor := postgres.GetExecutor(ctx, s.pool)
	if _, err := executor.Exec(ctx, query, docID, bookmarkType, cutoffUpdateID); err != nil {
		return fmt.Errorf("delete bookmarks by type and cutoff: %w", err)
	}
	return nil
}

func scanBookmarks(rows rowScanner) ([]collab.Bookmark, error) {
	bookmarks := make([]collab.Bookmark, 0)
	for rows.Next() {
		var b collab.Bookmark
		if err := rows.Scan(
			&b.ID,
			&b.DocumentID,
			&b.UpdateID,
			&b.State,
			&b.BookmarkType,
			&b.TurnID,
			&b.Name,
			&b.CreatedBy,
			&b.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan bookmark row: %w", err)
		}
		bookmarks = append(bookmarks, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bookmark rows: %w", err)
	}

	return bookmarks, nil
}

type rowScanner interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}
