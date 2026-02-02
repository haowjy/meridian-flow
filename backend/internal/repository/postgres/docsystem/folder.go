package docsystem

import (
	"context"
	"fmt"
	"strings"
	"time"

	"meridian/internal/domain"
	models "meridian/internal/domain/models/docsystem"
	docsysRepo "meridian/internal/domain/repositories/docsystem"

	"meridian/internal/repository/postgres"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresFolderRepository implements the FolderRepository interface
type PostgresFolderRepository struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
}

// NewFolderRepository creates a new folder repository
func NewFolderRepository(config *postgres.RepositoryConfig) docsysRepo.FolderRepository {
	return &PostgresFolderRepository{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// Create creates a new folder (is_hidden defaults to false)
func (r *PostgresFolderRepository) Create(ctx context.Context, folder *models.Folder) error {
	// Guard against duplicates at the application level
	existing, err := r.getFolderByNameAndParent(ctx, folder.ProjectID, folder.Name, folder.ParentID)
	if err != nil {
		return err
	}
	if existing != nil {
		// Return structured conflict error with existing folder ID
		return &domain.ConflictError{
			Message:      fmt.Sprintf("folder '%s' already exists at this level", folder.Name),
			ResourceType: "folder",
			ResourceID:   existing.ID,
		}
	}

	query := fmt.Sprintf(`
		INSERT INTO %s (project_id, parent_id, name, is_hidden, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, is_hidden, created_at, updated_at
	`, r.tables.Folders)

	executor := postgres.GetExecutor(ctx, r.pool)
	err = executor.QueryRow(ctx, query,
		folder.ProjectID,
		folder.ParentID,
		folder.Name,
		folder.IsHidden,
		folder.CreatedAt,
		folder.UpdatedAt,
	).Scan(&folder.ID, &folder.IsHidden, &folder.CreatedAt, &folder.UpdatedAt)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			// Fallback: query for existing folder if database detected duplicate
			existing, queryErr := r.getFolderByNameAndParent(ctx, folder.ProjectID, folder.Name, folder.ParentID)
			if queryErr != nil || existing == nil {
				// Can't find existing folder, return conflict error without ID
				return domain.NewConflictError("folder", "",
					fmt.Sprintf("folder '%s' already exists at this level", folder.Name))
			}

			// Return structured conflict error with resource ID
			return domain.NewConflictError("folder", existing.ID,
				fmt.Sprintf("folder '%s' already exists at this level", folder.Name))
		}

		// Handle NOT NULL violations
		if postgres.IsPgNotNullError(err) {
			code, msg, detail, column, constraint := postgres.GetPgErrorDetails(err)
			return &domain.ConstraintViolationError{
				Message:        fmt.Sprintf("Missing required field: %s", column),
				ConstraintType: "NOT NULL",
				ColumnName:     column,
				ConstraintName: constraint,
				InternalDetail: fmt.Sprintf("%s: %s (detail: %s)", code, msg, detail),
			}
		}

		// Handle CHECK constraint violations
		if postgres.IsPgCheckConstraintError(err) {
			code, msg, detail, _, constraint := postgres.GetPgErrorDetails(err)
			return &domain.ConstraintViolationError{
				Message:        "Data violates business rules",
				ConstraintType: "CHECK",
				ConstraintName: constraint,
				InternalDetail: fmt.Sprintf("%s: %s (detail: %s)", code, msg, detail),
			}
		}

		return fmt.Errorf("create folder: %w", err)
	}

	return nil
}

// CreateHidden creates a new hidden folder (e.g., for /.meridian/)
func (r *PostgresFolderRepository) CreateHidden(ctx context.Context, folder *models.Folder) error {
	folder.IsHidden = true
	return r.Create(ctx, folder)
}

// GetByID retrieves a folder by ID
func (r *PostgresFolderRepository) GetByID(ctx context.Context, id, projectID string) (*models.Folder, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, parent_id, name, is_hidden, created_at, updated_at
		FROM %s
		WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
	`, r.tables.Folders)

	var folder models.Folder
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, id, projectID).Scan(
		&folder.ID,
		&folder.ProjectID,
		&folder.ParentID,
		&folder.Name,
		&folder.IsHidden,
		&folder.CreatedAt,
		&folder.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("folder",
				fmt.Sprintf("folder %s not found", id))
		}
		return nil, fmt.Errorf("get folder: %w", err)
	}

	return &folder, nil
}

// GetByIDOnly retrieves a folder by UUID only (no project scoping)
// Use when authorization is handled separately (e.g., by ResourceAuthorizer)
func (r *PostgresFolderRepository) GetByIDOnly(ctx context.Context, id string) (*models.Folder, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, parent_id, name, is_hidden, created_at, updated_at
		FROM %s
		WHERE id = $1 AND deleted_at IS NULL
	`, r.tables.Folders)

	var folder models.Folder
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, id).Scan(
		&folder.ID,
		&folder.ProjectID,
		&folder.ParentID,
		&folder.Name,
		&folder.IsHidden,
		&folder.CreatedAt,
		&folder.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("folder",
				fmt.Sprintf("folder %s not found", id))
		}
		return nil, fmt.Errorf("get folder: %w", err)
	}

	return &folder, nil
}

// Update updates a folder
func (r *PostgresFolderRepository) Update(ctx context.Context, folder *models.Folder) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET parent_id = $1, name = $2, updated_at = $3
		WHERE id = $4 AND project_id = $5 AND deleted_at IS NULL
	`, r.tables.Folders)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query,
		folder.ParentID,
		folder.Name,
		folder.UpdatedAt,
		folder.ID,
		folder.ProjectID,
	)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			// Query for existing folder
			existing, queryErr := r.getFolderByNameAndParent(ctx, folder.ProjectID, folder.Name, folder.ParentID)
			if queryErr != nil || existing == nil {
				// Can't find existing folder, return conflict error without ID
				return domain.NewConflictError("folder", "",
					fmt.Sprintf("folder '%s' already exists at this level", folder.Name))
			}

			// Return structured conflict error with resource ID
			return domain.NewConflictError("folder", existing.ID,
				fmt.Sprintf("folder '%s' already exists at this level", folder.Name))
		}

		// Handle NOT NULL violations
		if postgres.IsPgNotNullError(err) {
			code, msg, detail, column, constraint := postgres.GetPgErrorDetails(err)
			return &domain.ConstraintViolationError{
				Message:        fmt.Sprintf("Missing required field: %s", column),
				ConstraintType: "NOT NULL",
				ColumnName:     column,
				ConstraintName: constraint,
				InternalDetail: fmt.Sprintf("%s: %s (detail: %s)", code, msg, detail),
			}
		}

		// Handle CHECK constraint violations
		if postgres.IsPgCheckConstraintError(err) {
			code, msg, detail, _, constraint := postgres.GetPgErrorDetails(err)
			return &domain.ConstraintViolationError{
				Message:        "Data violates business rules",
				ConstraintType: "CHECK",
				ConstraintName: constraint,
				InternalDetail: fmt.Sprintf("%s: %s (detail: %s)", code, msg, detail),
			}
		}

		return fmt.Errorf("update folder: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.NewNotFoundError("folder",
			fmt.Sprintf("folder %s not found", folder.ID))
	}

	return nil
}

// Delete soft-deletes a folder by setting deleted_at timestamp
func (r *PostgresFolderRepository) Delete(ctx context.Context, id, projectID string) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET deleted_at = NOW()
		WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
	`, r.tables.Folders)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, id, projectID)
	if err != nil {
		return fmt.Errorf("delete folder: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.NewNotFoundError("folder",
			fmt.Sprintf("folder %s not found", id))
	}

	return nil
}

// ListChildren lists immediate child folders
// If opts is nil, uses default options (IncludeHidden: false)
func (r *PostgresFolderRepository) ListChildren(ctx context.Context, folderID *string, projectID string, opts *docsysRepo.FolderFilterOptions) ([]models.Folder, error) {
	// Default: exclude hidden folders (e.g., .meridian)
	includeHidden := false
	if opts != nil {
		includeHidden = opts.IncludeHidden
	}

	var query string
	var args []interface{}

	if folderID == nil {
		query = fmt.Sprintf(`
			SELECT id, project_id, parent_id, name, is_hidden, created_at, updated_at
			FROM %s
			WHERE project_id = $1 AND parent_id IS NULL AND deleted_at IS NULL
		`, r.tables.Folders)
		args = append(args, projectID)
	} else {
		query = fmt.Sprintf(`
			SELECT id, project_id, parent_id, name, is_hidden, created_at, updated_at
			FROM %s
			WHERE project_id = $1 AND parent_id = $2 AND deleted_at IS NULL
		`, r.tables.Folders)
		args = append(args, projectID, *folderID)
	}

	// Filter hidden folders unless explicitly included
	if !includeHidden {
		query += ` AND is_hidden = false`
	}
	query += ` ORDER BY name ASC`

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list folder children: %w", err)
	}
	defer rows.Close()

	var folders []models.Folder
	for rows.Next() {
		var folder models.Folder
		err := rows.Scan(
			&folder.ID,
			&folder.ProjectID,
			&folder.ParentID,
			&folder.Name,
			&folder.IsHidden,
			&folder.CreatedAt,
			&folder.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan folder: %w", err)
		}
		folders = append(folders, folder)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate folders: %w", err)
	}

	return folders, nil
}

// CreateIfNotExists creates a folder only if it doesn't exist
func (r *PostgresFolderRepository) CreateIfNotExists(ctx context.Context, projectID string, parentID *string, name string) (*models.Folder, error) {
	// Check if folder already exists
	existing, err := r.getFolderByNameAndParent(ctx, projectID, name, parentID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, nil // Already exists, return it
	}

	// Create new folder
	now := time.Now()
	folder := &models.Folder{
		ProjectID: projectID,
		ParentID:  parentID,
		Name:      name,
		IsHidden:  false,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := r.Create(ctx, folder); err != nil {
		return nil, err
	}

	return folder, nil
}

// CreateHiddenIfNotExists creates a hidden folder only if it doesn't exist
func (r *PostgresFolderRepository) CreateHiddenIfNotExists(ctx context.Context, projectID string, parentID *string, name string) (*models.Folder, error) {
	// Check if folder already exists
	existing, err := r.getFolderByNameAndParent(ctx, projectID, name, parentID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, nil // Already exists, return it
	}

	// Create new hidden folder
	now := time.Now()
	folder := &models.Folder{
		ProjectID: projectID,
		ParentID:  parentID,
		Name:      name,
		IsHidden:  true,
		CreatedAt: now,
		UpdatedAt: now,
	}

	if err := r.Create(ctx, folder); err != nil {
		return nil, err
	}

	return folder, nil
}

// GetPath computes the path for a folder using recursive CTE
func (r *PostgresFolderRepository) GetPath(ctx context.Context, folderID *string, projectID string) (string, error) {
	if folderID == nil {
		return "", nil
	}

	query := fmt.Sprintf(`
		WITH RECURSIVE folder_path AS (
			-- Base case: start from the folder itself
			SELECT id, name, parent_id, name::text AS path
			FROM %s
			WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
			UNION ALL
			-- Recursive case: walk up the tree, prepending parent names
			SELECT f.id, f.name, f.parent_id, f.name || '/' || fp.path
			FROM %s f
			JOIN folder_path fp ON f.id = fp.parent_id
			WHERE f.deleted_at IS NULL
		)
		SELECT path FROM folder_path WHERE parent_id IS NULL
	`, r.tables.Folders, r.tables.Folders)

	var path string
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, *folderID, projectID).Scan(&path)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return "", domain.NewNotFoundError("folder",
				fmt.Sprintf("folder %s not found", *folderID))
		}
		return "", fmt.Errorf("get folder path: %w", err)
	}

	return path, nil
}

// GetAllByProject retrieves all folders in a project (flat list, includes hidden)
func (r *PostgresFolderRepository) GetAllByProject(ctx context.Context, projectID string) ([]models.Folder, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, parent_id, name, is_hidden, created_at, updated_at
		FROM %s
		WHERE project_id = $1 AND deleted_at IS NULL
		ORDER BY created_at ASC
	`, r.tables.Folders)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, projectID)
	if err != nil {
		return nil, fmt.Errorf("get all folders: %w", err)
	}
	defer rows.Close()

	var folders []models.Folder
	for rows.Next() {
		var folder models.Folder
		err := rows.Scan(
			&folder.ID,
			&folder.ProjectID,
			&folder.ParentID,
			&folder.Name,
			&folder.IsHidden,
			&folder.CreatedAt,
			&folder.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan folder: %w", err)
		}
		folders = append(folders, folder)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate folders: %w", err)
	}

	return folders, nil
}

// GetAllByProjectFiltered retrieves folders with filtering options
func (r *PostgresFolderRepository) GetAllByProjectFiltered(ctx context.Context, projectID string, opts docsysRepo.FolderFilterOptions) ([]models.Folder, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, parent_id, name, is_hidden, created_at, updated_at
		FROM %s
		WHERE project_id = $1 AND deleted_at IS NULL
	`, r.tables.Folders)

	if !opts.IncludeHidden {
		query += ` AND is_hidden = false`
	}
	query += ` ORDER BY created_at ASC`

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, projectID)
	if err != nil {
		return nil, fmt.Errorf("get all folders filtered: %w", err)
	}
	defer rows.Close()

	var folders []models.Folder
	for rows.Next() {
		var folder models.Folder
		err := rows.Scan(
			&folder.ID,
			&folder.ProjectID,
			&folder.ParentID,
			&folder.Name,
			&folder.IsHidden,
			&folder.CreatedAt,
			&folder.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan folder: %w", err)
		}
		folders = append(folders, folder)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate folders: %w", err)
	}

	return folders, nil
}

// GetByPath retrieves a folder by its full path (helper method, not in interface)
func (r *PostgresFolderRepository) GetByPath(ctx context.Context, projectID string, path string) (*models.Folder, error) {
	segments := strings.Split(strings.Trim(path, "/"), "/")
	if len(segments) == 0 || (len(segments) == 1 && segments[0] == "") {
		return nil, domain.NewValidationError("invalid path: path cannot be empty")
	}

	var currentParentID *string

	// Traverse path segment by segment
	for _, segment := range segments {
		folder, err := r.getFolderByNameAndParent(ctx, projectID, segment, currentParentID)
		if err != nil {
			return nil, err
		}
		if folder == nil {
			return nil, domain.NewNotFoundError("folder",
				fmt.Sprintf("folder at path '%s' not found", path))
		}
		currentParentID = &folder.ID
	}

	if currentParentID == nil {
		return nil, domain.NewNotFoundError("folder",
			fmt.Sprintf("folder at path '%s' not found", path))
	}

	return r.GetByID(ctx, *currentParentID, projectID)
}

// getFolderByNameAndParent is a helper to find a folder by name and parent
func (r *PostgresFolderRepository) getFolderByNameAndParent(ctx context.Context, projectID string, name string, parentID *string) (*models.Folder, error) {
	var query string
	var args []interface{}

	if parentID == nil {
		query = fmt.Sprintf(`
			SELECT id, project_id, parent_id, name, is_hidden, created_at, updated_at
			FROM %s
			WHERE project_id = $1 AND name = $2 AND parent_id IS NULL AND deleted_at IS NULL
		`, r.tables.Folders)
		args = append(args, projectID, name)
	} else {
		query = fmt.Sprintf(`
			SELECT id, project_id, parent_id, name, is_hidden, created_at, updated_at
			FROM %s
			WHERE project_id = $1 AND name = $2 AND parent_id = $3 AND deleted_at IS NULL
		`, r.tables.Folders)
		args = append(args, projectID, name, *parentID)
	}

	var folder models.Folder
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, args...).Scan(
		&folder.ID,
		&folder.ProjectID,
		&folder.ParentID,
		&folder.Name,
		&folder.IsHidden,
		&folder.CreatedAt,
		&folder.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, nil // Not found, not an error
		}
		return nil, fmt.Errorf("get folder by name and parent: %w", err)
	}

	return &folder, nil
}
