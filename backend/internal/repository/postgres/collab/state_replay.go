package collab

import (
	"context"
	"fmt"

	ycrdt "github.com/haowjy/y-crdt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"meridian/internal/repository/postgres"
)

type anyQueryExecutor interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

type updateRow struct {
	id     int64
	update []byte
}

func loadLatestCheckpoint(
	ctx context.Context,
	executor anyQueryExecutor,
	table string,
	docID string,
) (state []byte, upToID int64, found bool, err error) {
	query := fmt.Sprintf(`
		SELECT state, up_to_id
		FROM %s
		WHERE document_id = $1
		ORDER BY id DESC
		LIMIT 1
	`, table)

	if scanErr := executor.QueryRow(ctx, query, docID).Scan(&state, &upToID); scanErr != nil {
		if postgres.IsPgNoRowsError(scanErr) {
			return nil, 0, false, nil
		}
		return nil, 0, false, fmt.Errorf("load latest checkpoint: %w", scanErr)
	}
	return state, upToID, true, nil
}

func loadUpdateRowsAfter(
	ctx context.Context,
	executor anyQueryExecutor,
	table string,
	docID string,
	afterID int64,
) ([]updateRow, error) {
	query := fmt.Sprintf(`
		SELECT id, update
		FROM %s
		WHERE document_id = $1 AND id > $2
		ORDER BY id ASC
	`, table)

	rows, err := executor.Query(ctx, query, docID, afterID)
	if err != nil {
		return nil, fmt.Errorf("load updates after checkpoint: %w", err)
	}
	defer rows.Close()

	updates := make([]updateRow, 0)
	for rows.Next() {
		var row updateRow
		if scanErr := rows.Scan(&row.id, &row.update); scanErr != nil {
			return nil, fmt.Errorf("scan update row: %w", scanErr)
		}
		updates = append(updates, row)
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		return nil, fmt.Errorf("iterate update rows: %w", rowsErr)
	}

	return updates, nil
}

func loadUpdateRowsInRange(
	ctx context.Context,
	executor anyQueryExecutor,
	table string,
	docID string,
	afterID int64,
	upToID int64,
) ([]updateRow, error) {
	query := fmt.Sprintf(`
		SELECT id, update
		FROM %s
		WHERE document_id = $1
		  AND id > $2
		  AND id <= $3
		ORDER BY id ASC
	`, table)

	rows, err := executor.Query(ctx, query, docID, afterID, upToID)
	if err != nil {
		return nil, fmt.Errorf("load updates in range: %w", err)
	}
	defer rows.Close()

	updates := make([]updateRow, 0)
	for rows.Next() {
		var row updateRow
		if scanErr := rows.Scan(&row.id, &row.update); scanErr != nil {
			return nil, fmt.Errorf("scan update row: %w", scanErr)
		}
		updates = append(updates, row)
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		return nil, fmt.Errorf("iterate update rows: %w", rowsErr)
	}

	return updates, nil
}

func applyStateAndUpdates(docID string, checkpoint []byte, updates [][]byte) (*ycrdt.Doc, error) {
	doc := ycrdt.NewDoc(docID, true, ycrdt.DefaultGCFilter, nil, false)

	if len(checkpoint) > 0 {
		if err := safeApplyUpdate(doc, checkpoint, "checkpoint-replay"); err != nil {
			return nil, fmt.Errorf("apply checkpoint state: %w", err)
		}
	}
	for _, update := range updates {
		if len(update) == 0 {
			continue
		}
		if err := safeApplyUpdate(doc, update, "update-replay"); err != nil {
			return nil, fmt.Errorf("apply update during replay: %w", err)
		}
	}

	return doc, nil
}

func encodeDocState(doc *ycrdt.Doc) ([]byte, error) {
	state, err := safeEncodeStateAsUpdate(doc)
	if err != nil {
		return nil, fmt.Errorf("encode replayed state: %w", err)
	}
	return state, nil
}

func loadStateAtUpdateID(
	ctx context.Context,
	executor anyQueryExecutor,
	checkpointTable string,
	updateTable string,
	docID string,
	updateID int64,
) ([]byte, error) {
	checkpointQuery := fmt.Sprintf(`
		SELECT state, up_to_id
		FROM %s
		WHERE document_id = $1
		  AND up_to_id <= $2
		ORDER BY up_to_id DESC, id DESC
		LIMIT 1
	`, checkpointTable)

	var checkpointState []byte
	var checkpointUpToID int64
	if err := executor.QueryRow(ctx, checkpointQuery, docID, updateID).Scan(&checkpointState, &checkpointUpToID); err != nil {
		if !postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("load checkpoint for state replay: %w", err)
		}
		checkpointState = nil
		checkpointUpToID = 0
	}

	updateRows, err := loadUpdateRowsInRange(ctx, executor, updateTable, docID, checkpointUpToID, updateID)
	if err != nil {
		return nil, err
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

func safeApplyUpdate(doc *ycrdt.Doc, update []byte, origin interface{}) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("apply update panic: %v", r)
		}
	}()

	ycrdt.ApplyUpdate(doc, update, origin)
	return nil
}

func safeEncodeStateAsUpdate(doc *ycrdt.Doc) (state []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("encode state panic: %v", r)
		}
	}()

	state = ycrdt.EncodeStateAsUpdate(doc, nil)
	return state, nil
}
