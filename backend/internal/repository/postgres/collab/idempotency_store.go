package collab

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
	"meridian/internal/repository/postgres"
)

// PostgresIdempotencyStore persists collab idempotency records.
type PostgresIdempotencyStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

// NewIdempotencyStore creates a new idempotency store.
func NewIdempotencyStore(config *postgres.RepositoryConfig) collabSvc.IdempotencyStore {
	return &PostgresIdempotencyStore{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// GetByUserAndKey loads a request idempotency record.
func (s *PostgresIdempotencyStore) GetByUserAndKey(
	ctx context.Context,
	userID uuid.UUID,
	idempotencyKey string,
) (*collabModels.IdempotencyRecord, error) {
	query := fmt.Sprintf(`
		SELECT id, user_id, idempotency_key, request_scope, scope_id, request_hash,
		       document_id, response_payload, created_at, expires_at
		FROM %s
		WHERE user_id = $1 AND idempotency_key = $2 AND expires_at > NOW()
	`, s.tables.CollabRequestIdempotency)

	var record collabModels.IdempotencyRecord
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, userID, idempotencyKey).Scan(
		&record.ID,
		&record.UserID,
		&record.IdempotencyKey,
		&record.RequestScope,
		&record.ScopeID,
		&record.RequestHash,
		&record.DocumentID,
		&record.ResponsePayload,
		&record.CreatedAt,
		&record.ExpiresAt,
	); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get idempotency record: %w", err)
	}

	return &record, nil
}

// Create inserts a new idempotency record.
func (s *PostgresIdempotencyStore) Create(ctx context.Context, record *collabModels.IdempotencyRecord) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (
			user_id, idempotency_key, request_scope, scope_id, request_hash,
			document_id, response_payload, expires_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, created_at
	`, s.tables.CollabRequestIdempotency)

	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(
		ctx,
		query,
		record.UserID,
		record.IdempotencyKey,
		record.RequestScope,
		record.ScopeID,
		record.RequestHash,
		record.DocumentID,
		record.ResponsePayload,
		record.ExpiresAt,
	).Scan(&record.ID, &record.CreatedAt); err != nil {
		if postgres.IsPgDuplicateError(err) {
			return domain.NewConflictError(
				"idempotency_key",
				record.IdempotencyKey,
				fmt.Sprintf("idempotency key %q already exists", record.IdempotencyKey),
			)
		}
		return fmt.Errorf("create idempotency record: %w", err)
	}

	return nil
}

// DeleteExpired deletes expired idempotency rows.
func (s *PostgresIdempotencyStore) DeleteExpired(ctx context.Context, now time.Time) (int64, error) {
	query := fmt.Sprintf(`
		DELETE FROM %s
		WHERE expires_at < $1
	`, s.tables.CollabRequestIdempotency)

	executor := postgres.GetExecutor(ctx, s.pool)
	tag, err := executor.Exec(ctx, query, now)
	if err != nil {
		return 0, fmt.Errorf("delete expired idempotency records: %w", err)
	}

	return tag.RowsAffected(), nil
}
