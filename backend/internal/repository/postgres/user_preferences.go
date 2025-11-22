package postgres

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"meridian/internal/domain/models"
	"meridian/internal/domain/repositories"
)

// PostgresUserPreferencesRepository implements the UserPreferencesRepository interface
type PostgresUserPreferencesRepository struct {
	pool   *pgxpool.Pool
	tables *TableNames
	logger *slog.Logger
}

// NewUserPreferencesRepository creates a new PostgresUserPreferencesRepository
func NewUserPreferencesRepository(config *RepositoryConfig) repositories.UserPreferencesRepository {
	return &PostgresUserPreferencesRepository{
		pool:   config.Pool,
		tables: config.Tables,
		logger: config.Logger,
	}
}

// GetByUserID retrieves preferences for a specific user
func (r *PostgresUserPreferencesRepository) GetByUserID(ctx context.Context, userID uuid.UUID) (*models.UserPreferences, error) {
	query := fmt.Sprintf(`
		SELECT user_id, preferences, created_at, updated_at
		FROM %s
		WHERE user_id = $1
	`, r.tables.UserPreferences)

	var prefs models.UserPreferences
	executor := GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, userID).Scan(
		&prefs.UserID,
		&prefs.Preferences,
		&prefs.CreatedAt,
		&prefs.UpdatedAt,
	)

	if err != nil {
		if err == pgx.ErrNoRows {
			// No preferences exist yet - return nil (not an error)
			return nil, nil
		}
		return nil, fmt.Errorf("get user preferences: %w", err)
	}

	return &prefs, nil
}

// Upsert creates or updates user preferences
func (r *PostgresUserPreferencesRepository) Upsert(ctx context.Context, prefs *models.UserPreferences) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (user_id, preferences, created_at, updated_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id) DO UPDATE SET
			preferences = EXCLUDED.preferences,
			updated_at = EXCLUDED.updated_at
		RETURNING user_id, preferences, created_at, updated_at
	`, r.tables.UserPreferences)

	executor := GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query,
		prefs.UserID,
		prefs.Preferences,
		prefs.CreatedAt,
		prefs.UpdatedAt,
	).Scan(
		&prefs.UserID,
		&prefs.Preferences,
		&prefs.CreatedAt,
		&prefs.UpdatedAt,
	)

	if err != nil {
		return fmt.Errorf("upsert user preferences: %w", err)
	}

	return nil
}
