package collab

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"meridian/internal/domain"
	collabSvc "meridian/internal/domain/services/collab"
	"meridian/internal/repository/postgres"
)

// PostgresAutoAcceptStore loads project/user auto-accept tri-state policy inputs.
type PostgresAutoAcceptStore struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
	logger *slog.Logger
}

func NewAutoAcceptStore(config *postgres.RepositoryConfig) collabSvc.AutoAcceptPolicyStore {
	return &PostgresAutoAcceptStore{
		pool:   config.Pool,
		tables: config.Tables,
		logger: config.Logger,
	}
}

func (s *PostgresAutoAcceptStore) GetPolicyInputs(
	ctx context.Context,
	documentID uuid.UUID,
	userID uuid.UUID,
) (*collabSvc.AutoAcceptPolicyInputs, error) {
	query := fmt.Sprintf(`
		SELECT
			p.auto_accept_proposals,
			CASE
				WHEN jsonb_typeof(up.preferences->'collab'->'auto_accept_proposals') = 'boolean'
				THEN up.preferences->'collab'->>'auto_accept_proposals'
				ELSE NULL
			END AS user_auto_accept
		FROM %s d
		JOIN %s p ON p.id = d.project_id
		LEFT JOIN %s up ON up.user_id = $2
		WHERE d.id = $1 AND d.deleted_at IS NULL
	`, s.tables.Documents, s.tables.Projects, s.tables.UserPreferences)

	var projectValue sql.NullBool
	var userValue sql.NullString
	executor := postgres.GetExecutor(ctx, s.pool)
	if err := executor.QueryRow(ctx, query, documentID, userID).Scan(&projectValue, &userValue); err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("document", fmt.Sprintf("document %s not found", documentID))
		}
		return nil, fmt.Errorf("load auto-accept policy inputs: %w", err)
	}

	inputs := &collabSvc.AutoAcceptPolicyInputs{
		Project: nullBoolToPtr(projectValue),
		User:    parseJSONBoolString(userValue),
	}

	return inputs, nil
}

func nullBoolToPtr(value sql.NullBool) *bool {
	if !value.Valid {
		return nil
	}
	result := value.Bool
	return &result
}

func parseJSONBoolString(value sql.NullString) *bool {
	if !value.Valid {
		return nil
	}

	switch strings.TrimSpace(strings.ToLower(value.String)) {
	case "true":
		result := true
		return &result
	case "false":
		result := false
		return &result
	default:
		return nil
	}
}
