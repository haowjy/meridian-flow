package docsystem

import (
	"context"
	"fmt"

	"meridian/internal/domain"
	models "meridian/internal/domain/models/docsystem"
	docsysRepo "meridian/internal/domain/repositories/docsystem"

	"meridian/internal/repository/postgres"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresProjectRepository implements the ProjectRepository interface
type PostgresProjectRepository struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

// NewProjectRepository creates a new project repository
func NewProjectRepository(config *postgres.RepositoryConfig) docsysRepo.ProjectRepository {
	return &PostgresProjectRepository{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// Create creates a new project
func (r *PostgresProjectRepository) Create(ctx context.Context, project *models.Project) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (user_id, name, created_at, updated_at)
		VALUES ($1, $2, $3, $4)
		RETURNING id, created_at, updated_at
	`, r.tables.Projects)

	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query,
		project.UserID,
		project.Name,
		project.CreatedAt,
		project.UpdatedAt,
	).Scan(&project.ID, &project.CreatedAt, &project.UpdatedAt)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			// Query for the existing project to get its ID
			existingID, queryErr := r.getExistingProjectID(ctx, project.UserID, project.Name)
			if queryErr != nil {
				// Fallback to generic conflict error if we can't find the existing project
				return fmt.Errorf("project '%s' already exists: %w", project.Name, domain.ErrConflict)
			}

			// Return structured conflict error with resource ID
			return &domain.ConflictError{
				Message:      fmt.Sprintf("project '%s' already exists", project.Name),
				ResourceType: "project",
				ResourceID:   existingID,
			}
		}
		return fmt.Errorf("create project: %w", err)
	}

	return nil
}

// GetByID retrieves a project by ID
func (r *PostgresProjectRepository) GetByID(ctx context.Context, id, userID string) (*models.Project, error) {
	query := fmt.Sprintf(`
		SELECT id, user_id, name, created_at, updated_at
		FROM %s
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
	`, r.tables.Projects)

	var project models.Project
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, id, userID).Scan(
		&project.ID,
		&project.UserID,
		&project.Name,
		&project.CreatedAt,
		&project.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("project %s: %w", id, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("get project: %w", err)
	}

	return &project, nil
}

// List retrieves all projects for a user, ordered by updated_at DESC
func (r *PostgresProjectRepository) List(ctx context.Context, userID string) ([]models.Project, error) {
	query := fmt.Sprintf(`
		SELECT id, user_id, name, created_at, updated_at
		FROM %s
		WHERE user_id = $1 AND deleted_at IS NULL
		ORDER BY updated_at DESC
	`, r.tables.Projects)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()

	var projects []models.Project
	for rows.Next() {
		var project models.Project
		err := rows.Scan(
			&project.ID,
			&project.UserID,
			&project.Name,
			&project.CreatedAt,
			&project.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		projects = append(projects, project)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate projects: %w", err)
	}

	// Return empty slice instead of nil if no projects
	if projects == nil {
		projects = []models.Project{}
	}

	return projects, nil
}

// Update updates a project's name and updated_at timestamp
func (r *PostgresProjectRepository) Update(ctx context.Context, project *models.Project) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET name = $1, updated_at = $2
		WHERE id = $3 AND user_id = $4
	`, r.tables.Projects)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query,
		project.Name,
		project.UpdatedAt,
		project.ID,
		project.UserID,
	)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			// Query for the existing project to get its ID
			existingID, queryErr := r.getExistingProjectID(ctx, project.UserID, project.Name)
			if queryErr != nil {
				// Fallback to generic conflict error if we can't find the existing project
				return fmt.Errorf("project name '%s' already exists: %w", project.Name, domain.ErrConflict)
			}

			// Return structured conflict error with resource ID
			return &domain.ConflictError{
				Message:      fmt.Sprintf("project name '%s' already exists", project.Name),
				ResourceType: "project",
				ResourceID:   existingID,
			}
		}
		return fmt.Errorf("update project: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("project %s: %w", project.ID, domain.ErrNotFound)
	}

	return nil
}

// Delete soft-deletes a project by setting deleted_at timestamp and returns the deleted project
func (r *PostgresProjectRepository) Delete(ctx context.Context, id, userID string) (*models.Project, error) {
	query := fmt.Sprintf(`
		UPDATE %s
		SET deleted_at = NOW()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING id, user_id, name, created_at, updated_at, deleted_at
	`, r.tables.Projects)

	var project models.Project
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, id, userID).Scan(
		&project.ID,
		&project.UserID,
		&project.Name,
		&project.CreatedAt,
		&project.UpdatedAt,
		&project.DeletedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("project %s: %w", id, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("delete project: %w", err)
	}

	return &project, nil
}

// getExistingProjectID queries for an existing project by user_id and name
// Returns the project ID if found, error otherwise
func (r *PostgresProjectRepository) getExistingProjectID(ctx context.Context, userID, name string) (string, error) {
	query := fmt.Sprintf(`
		SELECT id
		FROM %s
		WHERE user_id = $1 AND name = $2 AND deleted_at IS NULL
	`, r.tables.Projects)

	var id string
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, userID, name).Scan(&id)
	if err != nil {
		return "", fmt.Errorf("get existing project ID: %w", err)
	}

	return id, nil
}
