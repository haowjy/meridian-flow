package docsystem

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	docsysRepo "meridian/internal/domain/repositories/docsystem"
	"meridian/internal/repository/postgres"
)

// PostgresFavoriteRepository implements the FavoriteRepository interface
type PostgresFavoriteRepository struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

// NewFavoriteRepository creates a new favorite repository
func NewFavoriteRepository(config *postgres.RepositoryConfig) docsysRepo.FavoriteRepository {
	return &PostgresFavoriteRepository{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// Add marks a project as favorite for a user (idempotent)
func (r *PostgresFavoriteRepository) Add(ctx context.Context, userID, projectID string) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (user_id, project_id, created_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (user_id, project_id) DO NOTHING
	`, r.tables.UserProjectFavorites)

	executor := postgres.GetExecutor(ctx, r.pool)
	_, err := executor.Exec(ctx, query, userID, projectID)
	if err != nil {
		return fmt.Errorf("add favorite: %w", err)
	}

	return nil
}

// Remove unmarks a project as favorite for a user (idempotent)
func (r *PostgresFavoriteRepository) Remove(ctx context.Context, userID, projectID string) error {
	query := fmt.Sprintf(`
		DELETE FROM %s
		WHERE user_id = $1 AND project_id = $2
	`, r.tables.UserProjectFavorites)

	executor := postgres.GetExecutor(ctx, r.pool)
	_, err := executor.Exec(ctx, query, userID, projectID)
	if err != nil {
		return fmt.Errorf("remove favorite: %w", err)
	}

	return nil
}
