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
		INSERT INTO %s (user_id, name, slug, created_at, updated_at, last_activity_at)
		VALUES ($1, $2, $3, $4, $5, $5)
		RETURNING id, created_at, updated_at, last_activity_at
	`, r.tables.Projects)

	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query,
		project.UserID,
		project.Name,
		project.Slug,
		project.CreatedAt,
		project.UpdatedAt,
	).Scan(&project.ID, &project.CreatedAt, &project.UpdatedAt, &project.LastActivityAt)

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

// GetByID retrieves a project by ID with favorite status
func (r *PostgresProjectRepository) GetByID(ctx context.Context, id, userID string) (*models.Project, error) {
	query := fmt.Sprintf(`
		SELECT p.id, p.user_id, p.name, p.slug, p.system_prompt, p.last_activity_at, p.created_at, p.updated_at,
		       (f.user_id IS NOT NULL) AS is_favorite
		FROM %s p
		LEFT JOIN %s f ON p.id = f.project_id AND f.user_id = $2
		WHERE p.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL
	`, r.tables.Projects, r.tables.UserProjectFavorites)

	var project models.Project
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, id, userID).Scan(
		&project.ID,
		&project.UserID,
		&project.Name,
		&project.Slug,
		&project.SystemPrompt,
		&project.LastActivityAt,
		&project.CreatedAt,
		&project.UpdatedAt,
		&project.IsFavorite,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("project %s: %w", id, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("get project: %w", err)
	}

	return &project, nil
}

// GetBySlug retrieves a project by slug (unique per user) with favorite status
func (r *PostgresProjectRepository) GetBySlug(ctx context.Context, slug, userID string) (*models.Project, error) {
	query := fmt.Sprintf(`
		SELECT p.id, p.user_id, p.name, p.slug, p.system_prompt, p.last_activity_at, p.created_at, p.updated_at,
		       (f.user_id IS NOT NULL) AS is_favorite
		FROM %s p
		LEFT JOIN %s f ON p.id = f.project_id AND f.user_id = $2
		WHERE p.slug = $1 AND p.user_id = $2 AND p.deleted_at IS NULL
	`, r.tables.Projects, r.tables.UserProjectFavorites)

	var project models.Project
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, slug, userID).Scan(
		&project.ID,
		&project.UserID,
		&project.Name,
		&project.Slug,
		&project.SystemPrompt,
		&project.LastActivityAt,
		&project.CreatedAt,
		&project.UpdatedAt,
		&project.IsFavorite,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("project with slug '%s': %w", slug, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("get project by slug: %w", err)
	}

	return &project, nil
}

// SlugExists checks if a slug is already used by another project for this user
func (r *PostgresProjectRepository) SlugExists(ctx context.Context, slug, userID string, excludeID *string) (bool, error) {
	var query string
	var args []interface{}

	if excludeID != nil {
		query = fmt.Sprintf(`
			SELECT EXISTS(
				SELECT 1 FROM %s
				WHERE slug = $1 AND user_id = $2 AND id != $3 AND deleted_at IS NULL
			)
		`, r.tables.Projects)
		args = []interface{}{slug, userID, *excludeID}
	} else {
		query = fmt.Sprintf(`
			SELECT EXISTS(
				SELECT 1 FROM %s
				WHERE slug = $1 AND user_id = $2 AND deleted_at IS NULL
			)
		`, r.tables.Projects)
		args = []interface{}{slug, userID}
	}

	var exists bool
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, args...).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("check slug exists: %w", err)
	}

	return exists, nil
}

// List retrieves all projects for a user with favorite status, ordered by last_activity_at DESC
func (r *PostgresProjectRepository) List(ctx context.Context, userID string) ([]models.Project, error) {
	query := fmt.Sprintf(`
		SELECT p.id, p.user_id, p.name, p.slug, p.system_prompt, p.last_activity_at, p.created_at, p.updated_at,
		       (f.user_id IS NOT NULL) AS is_favorite
		FROM %s p
		LEFT JOIN %s f ON p.id = f.project_id AND f.user_id = $1
		WHERE p.user_id = $1 AND p.deleted_at IS NULL
		ORDER BY p.last_activity_at DESC
	`, r.tables.Projects, r.tables.UserProjectFavorites)

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
			&project.Slug,
			&project.SystemPrompt,
			&project.LastActivityAt,
			&project.CreatedAt,
			&project.UpdatedAt,
			&project.IsFavorite,
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

// Update updates a project's name, slug, system_prompt, and updated_at timestamp
func (r *PostgresProjectRepository) Update(ctx context.Context, project *models.Project) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET name = $1, slug = $2, system_prompt = $3, updated_at = $4
		WHERE id = $5 AND user_id = $6 AND deleted_at IS NULL
	`, r.tables.Projects)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query,
		project.Name,
		project.Slug,
		project.SystemPrompt,
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
		RETURNING id, user_id, name, slug, system_prompt, last_activity_at, created_at, updated_at, deleted_at
	`, r.tables.Projects)

	var project models.Project
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, id, userID).Scan(
		&project.ID,
		&project.UserID,
		&project.Name,
		&project.Slug,
		&project.SystemPrompt,
		&project.LastActivityAt,
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

// TouchLastActivityAt updates the last_activity_at timestamp to NOW()
func (r *PostgresProjectRepository) TouchLastActivityAt(ctx context.Context, projectID string) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET last_activity_at = NOW()
		WHERE id = $1 AND deleted_at IS NULL
	`, r.tables.Projects)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, projectID)
	if err != nil {
		return fmt.Errorf("touch last_activity_at: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("project %s: %w", projectID, domain.ErrNotFound)
	}

	return nil
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
