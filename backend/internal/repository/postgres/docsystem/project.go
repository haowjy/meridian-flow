package docsystem

import (
	"context"
	"fmt"

	"meridian/internal/domain"
	domaindocsys "meridian/internal/domain/docsystem"

	"meridian/internal/repository/postgres"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresProjectRepository implements the ProjectStore interface
type PostgresProjectRepository struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

const projectSelectColumns = "p.id, p.user_id, p.name, p.slug, p.system_prompt, p.autoapply, p.preferences, p.last_activity_at, p.created_at, p.updated_at"

// NewProjectRepository creates a new project repository
func NewProjectRepository(config *postgres.RepositoryConfig) domaindocsys.ProjectStore {
	return &PostgresProjectRepository{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// Create creates a new project
func (r *PostgresProjectRepository) Create(ctx context.Context, project *domaindocsys.Project) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (user_id, name, slug, autoapply, created_at, updated_at, last_activity_at)
		VALUES ($1, $2, $3, $4, $5, $6, $6)
		RETURNING id, autoapply, created_at, updated_at, last_activity_at
	`, r.tables.Projects)

	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query,
		project.UserID,
		project.Name,
		project.Slug,
		project.Autoapply,
		project.CreatedAt,
		project.UpdatedAt,
	).Scan(
		&project.ID,
		&project.Autoapply,
		&project.CreatedAt,
		&project.UpdatedAt,
		&project.LastActivityAt,
	)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			// Query for the existing project to get its ID
			existingID, queryErr := r.getExistingProjectID(ctx, project.UserID, project.Name)
			if queryErr != nil {
				// Fallback to conflict error without ID if we can't find the existing project
				return domain.NewConflictError("project", "",
					fmt.Sprintf("project '%s' already exists", project.Name))
			}

			// Return structured conflict error with resource ID
			return domain.NewConflictError("project", existingID,
				fmt.Sprintf("project '%s' already exists", project.Name))
		}
		return fmt.Errorf("create project: %w", err)
	}

	return nil
}

// GetByID retrieves a project by ID with favorite status
func (r *PostgresProjectRepository) GetByID(ctx context.Context, id, userID string) (*domaindocsys.Project, error) {
	query := fmt.Sprintf(`
		SELECT %s,
		       (f.user_id IS NOT NULL) AS is_favorite
		FROM %s p
		LEFT JOIN %s f ON p.id = f.project_id AND f.user_id = $2
		WHERE p.id = $1 AND p.user_id = $2 AND p.deleted_at IS NULL
	`, projectSelectColumns, r.tables.Projects, r.tables.UserProjectFavorites)

	var project domaindocsys.Project
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, id, userID).Scan(
		&project.ID,
		&project.UserID,
		&project.Name,
		&project.Slug,
		&project.SystemPrompt,
		&project.Autoapply,
		&project.Preferences,
		&project.LastActivityAt,
		&project.CreatedAt,
		&project.UpdatedAt,
		&project.IsFavorite,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("project",
				fmt.Sprintf("project %s not found", id))
		}
		return nil, fmt.Errorf("get project: %w", err)
	}

	return &project, nil
}

// GetByIDOnly retrieves a project by ID without user scoping.
func (r *PostgresProjectRepository) GetByIDOnly(ctx context.Context, id string) (*domaindocsys.Project, error) {
	query := fmt.Sprintf(`
		SELECT %s
		FROM %s p
		WHERE p.id = $1 AND p.deleted_at IS NULL
	`, projectSelectColumns, r.tables.Projects)

	var project domaindocsys.Project
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, id).Scan(
		&project.ID,
		&project.UserID,
		&project.Name,
		&project.Slug,
		&project.SystemPrompt,
		&project.Autoapply,
		&project.Preferences,
		&project.LastActivityAt,
		&project.CreatedAt,
		&project.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("project",
				fmt.Sprintf("project %s not found", id))
		}
		return nil, fmt.Errorf("get project: %w", err)
	}

	return &project, nil
}

// GetBySlug retrieves a project by slug (unique per user) with favorite status
func (r *PostgresProjectRepository) GetBySlug(ctx context.Context, slug, userID string) (*domaindocsys.Project, error) {
	query := fmt.Sprintf(`
		SELECT %s,
		       (f.user_id IS NOT NULL) AS is_favorite
		FROM %s p
		LEFT JOIN %s f ON p.id = f.project_id AND f.user_id = $2
		WHERE p.slug = $1 AND p.user_id = $2 AND p.deleted_at IS NULL
	`, projectSelectColumns, r.tables.Projects, r.tables.UserProjectFavorites)

	var project domaindocsys.Project
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, slug, userID).Scan(
		&project.ID,
		&project.UserID,
		&project.Name,
		&project.Slug,
		&project.SystemPrompt,
		&project.Autoapply,
		&project.Preferences,
		&project.LastActivityAt,
		&project.CreatedAt,
		&project.UpdatedAt,
		&project.IsFavorite,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("project",
				fmt.Sprintf("project with slug '%s' not found", slug))
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
func (r *PostgresProjectRepository) List(ctx context.Context, userID string) ([]domaindocsys.Project, error) {
	query := fmt.Sprintf(`
		SELECT %s,
		       (f.user_id IS NOT NULL) AS is_favorite
		FROM %s p
		LEFT JOIN %s f ON p.id = f.project_id AND f.user_id = $1
		WHERE p.user_id = $1 AND p.deleted_at IS NULL
		ORDER BY p.last_activity_at DESC
	`, projectSelectColumns, r.tables.Projects, r.tables.UserProjectFavorites)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()

	var projects []domaindocsys.Project
	for rows.Next() {
		var project domaindocsys.Project
		err := rows.Scan(
			&project.ID,
			&project.UserID,
			&project.Name,
			&project.Slug,
			&project.SystemPrompt,
			&project.Autoapply,
			&project.Preferences,
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
		projects = []domaindocsys.Project{}
	}

	return projects, nil
}

// Update updates a project's name, slug, system_prompt, preferences, and updated_at timestamp
func (r *PostgresProjectRepository) Update(ctx context.Context, project *domaindocsys.Project) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET name = $1, slug = $2, system_prompt = $3, autoapply = $4, preferences = $5, updated_at = $6
		WHERE id = $7 AND user_id = $8 AND deleted_at IS NULL
	`, r.tables.Projects)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query,
		project.Name,
		project.Slug,
		project.SystemPrompt,
		project.Autoapply,
		project.Preferences,
		project.UpdatedAt,
		project.ID,
		project.UserID,
	)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			// Query for the existing project to get its ID
			existingID, queryErr := r.getExistingProjectID(ctx, project.UserID, project.Name)
			if queryErr != nil {
				// Fallback to conflict error without ID if we can't find the existing project
				return domain.NewConflictError("project", "",
					fmt.Sprintf("project name '%s' already exists", project.Name))
			}

			// Return structured conflict error with resource ID
			return domain.NewConflictError("project", existingID,
				fmt.Sprintf("project name '%s' already exists", project.Name))
		}
		return fmt.Errorf("update project: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.NewNotFoundError("project",
			fmt.Sprintf("project %s not found", project.ID))
	}

	return nil
}

// Delete soft-deletes a project by setting deleted_at timestamp and returns the deleted project
func (r *PostgresProjectRepository) Delete(ctx context.Context, id, userID string) (*domaindocsys.Project, error) {
	query := fmt.Sprintf(`
		UPDATE %s
		SET deleted_at = NOW()
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING id, user_id, name, slug, system_prompt, autoapply, preferences, last_activity_at, created_at, updated_at, deleted_at
	`, r.tables.Projects)

	var project domaindocsys.Project
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, id, userID).Scan(
		&project.ID,
		&project.UserID,
		&project.Name,
		&project.Slug,
		&project.SystemPrompt,
		&project.Autoapply,
		&project.Preferences,
		&project.LastActivityAt,
		&project.CreatedAt,
		&project.UpdatedAt,
		&project.DeletedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("project",
				fmt.Sprintf("project %s not found", id))
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
		return domain.NewNotFoundError("project",
			fmt.Sprintf("project %s not found", projectID))
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
