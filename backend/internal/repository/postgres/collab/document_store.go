package collab

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	"meridian/internal/repository/postgres"
)

const (
	bookmarkTypeManual        = "manual"
	bookmarkTypeDaily         = "daily"
	bookmarkTypeSafetyRestore = "safety_restore"
)

var legacySnapshotBookmarkTypes = []string{
	bookmarkTypeManual,
	bookmarkTypeDaily,
	bookmarkTypeSafetyRestore,
}

// PostgresDocumentStore persists collab document state and legacy snapshot APIs.
type PostgresDocumentStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

// NewDocumentStore creates a service-scoped document store.
// Returns the concrete type so callers can use it as DocumentStateStore,
// CheckpointStore, SnapshotStore, and DocumentContentLoader.
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

// SaveSnapshot persists a restore/history point via bookmarks (legacy SnapshotStore API).
func (s *PostgresDocumentStore) SaveSnapshot(
	ctx context.Context,
	docID string,
	state []byte,
	snapshotType string,
	name *string,
	createdByUserID *string,
) (string, error) {
	query := fmt.Sprintf(`
		INSERT INTO %s (document_id, update_id, state, bookmark_type, turn_id, name, created_by)
		VALUES ($1, NULL, $2, $3, NULL, $4, $5)
		RETURNING id
	`, s.tables.CollabDocumentBookmarks)

	bookmarkType := snapshotTypeToBookmarkType(snapshotType)

	var id string
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, docID, state, bookmarkType, name, createdByUserID).Scan(&id); err != nil {
		return "", fmt.Errorf("save bookmark snapshot: %w", err)
	}

	return id, nil
}

// ListSnapshots returns paginated bookmarks using legacy snapshot DTO shape.
func (s *PostgresDocumentStore) ListSnapshots(ctx context.Context, docID string, limit, offset int) ([]collabModels.Snapshot, int, error) {
	countQuery := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s
		WHERE document_id = $1
		  AND bookmark_type = ANY($2)
	`, s.tables.CollabDocumentBookmarks)

	executor := postgres.GetExecutor(ctx, s.pool)
	var total int
	if err := executor.QueryRow(ctx, countQuery, docID, legacySnapshotBookmarkTypes).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count bookmark snapshots: %w", err)
	}

	if total == 0 {
		return []collabModels.Snapshot{}, 0, nil
	}

	query := fmt.Sprintf(`
		SELECT id, document_id::text, bookmark_type, name, created_by::text, created_at
		FROM %s
		WHERE document_id = $1
		  AND bookmark_type = ANY($2)
		ORDER BY created_at DESC, id DESC
		LIMIT $3 OFFSET $4
	`, s.tables.CollabDocumentBookmarks)

	rows, err := executor.Query(ctx, query, docID, legacySnapshotBookmarkTypes, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("list bookmark snapshots: %w", err)
	}
	defer rows.Close()

	snapshots := make([]collabModels.Snapshot, 0, limit)
	for rows.Next() {
		var (
			snapshotType string
			snap         collabModels.Snapshot
		)
		if err := rows.Scan(
			&snap.ID,
			&snap.DocumentID,
			&snapshotType,
			&snap.Name,
			&snap.CreatedByUserID,
			&snap.CreatedAt,
		); err != nil {
			return nil, 0, fmt.Errorf("scan bookmark snapshot: %w", err)
		}
		snap.SnapshotType = bookmarkTypeToSnapshotType(snapshotType)
		snapshots = append(snapshots, snap)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("list bookmark snapshots: row iteration: %w", err)
	}

	return snapshots, total, nil
}

// GetSnapshot retrieves a single snapshot, resolving pointer bookmarks if needed.
func (s *PostgresDocumentStore) GetSnapshot(ctx context.Context, snapshotID string) (*collabModels.SnapshotWithState, error) {
	query := fmt.Sprintf(`
		SELECT id, document_id::text, update_id, state, bookmark_type, name, created_by::text, created_at
		FROM %s
		WHERE id = $1
	`, s.tables.CollabDocumentBookmarks)

	var (
		snap         collabModels.SnapshotWithState
		updateID     *int64
		bookmarkType string
	)

	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, snapshotID).Scan(
		&snap.ID,
		&snap.DocumentID,
		&updateID,
		&snap.YjsState,
		&bookmarkType,
		&snap.Name,
		&snap.CreatedByUserID,
		&snap.CreatedAt,
	); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("snapshot", fmt.Sprintf("snapshot %s not found", snapshotID))
		}
		return nil, fmt.Errorf("get bookmark snapshot: %w", err)
	}

	snap.SnapshotType = bookmarkTypeToSnapshotType(bookmarkType)
	if len(snap.YjsState) == 0 && updateID != nil {
		state, replayErr := loadStateAtUpdateID(
			ctx,
			executor,
			s.tables.CollabDocumentCheckpoints,
			s.tables.CollabDocumentUpdates,
			snap.DocumentID,
			*updateID,
		)
		if replayErr != nil {
			return nil, replayErr
		}
		snap.YjsState = state
	}

	return &snap, nil
}

// DeleteSnapshot removes one snapshot bookmark by ID.
func (s *PostgresDocumentStore) DeleteSnapshot(ctx context.Context, snapshotID string) error {
	query := fmt.Sprintf(`
		DELETE FROM %s
		WHERE id = $1
		  AND bookmark_type = ANY($2)
	`, s.tables.CollabDocumentBookmarks)

	executor := postgres.GetExecutor(ctx, s.pool)
	cmdTag, err := executor.Exec(ctx, query, snapshotID, legacySnapshotBookmarkTypes)
	if err != nil {
		return fmt.Errorf("delete bookmark snapshot: %w", err)
	}

	if cmdTag.RowsAffected() == 0 {
		return domain.NewNotFoundError("snapshot", fmt.Sprintf("snapshot %s not found", snapshotID))
	}
	return nil
}

// DeleteExpiredAutoSnapshots is retained for temporary compatibility.
// Auto cleanup is replaced by append-only compaction.
func (s *PostgresDocumentStore) DeleteExpiredAutoSnapshots(context.Context, int) (int64, error) {
	return 0, nil
}

func snapshotTypeToBookmarkType(snapshotType string) string {
	switch snapshotType {
	case "named":
		return bookmarkTypeManual
	case "pre_restore":
		return bookmarkTypeSafetyRestore
	case "auto", "auto_human", "auto_ai_accept":
		return bookmarkTypeDaily
	default:
		return bookmarkTypeManual
	}
}

func bookmarkTypeToSnapshotType(bookmarkType string) string {
	switch bookmarkType {
	case bookmarkTypeManual:
		return "named"
	case bookmarkTypeSafetyRestore:
		return "pre_restore"
	case bookmarkTypeDaily:
		return "auto"
	default:
		return bookmarkType
	}
}
