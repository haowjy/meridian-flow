package postgres

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"meridian/internal/domain"
	"meridian/internal/domain/models"
	"meridian/internal/domain/repositories"
)

// PostgresFolderRepository implements the FolderRepository interface
type PostgresFolderRepository struct {
	pool   *pgxpool.Pool
	tables *TableNames
}

// NewFolderRepository creates a new folder repository
func NewFolderRepository(config *RepositoryConfig) repositories.FolderRepository {
	return &PostgresFolderRepository{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// Create creates a new folder
func (r *PostgresFolderRepository) Create(ctx context.Context, folder *models.Folder) error {
	// Guard against duplicates at the application level
	existing, err := r.getFolderByNameAndParent(ctx, folder.ProjectID, folder.Name, folder.ParentID)
	if err != nil {
		return err
	}
	if existing != nil {
		return fmt.Errorf("folder '%s': %w", folder.Name, domain.ErrConflict)
	}

	query := fmt.Sprintf(`
		INSERT INTO %s (project_id, parent_id, name, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at, updated_at
	`, r.tables.Folders)

	err = r.pool.QueryRow(ctx, query,
		folder.ProjectID,
		folder.ParentID,
		folder.Name,
		folder.CreatedAt,
		folder.UpdatedAt,
	).Scan(&folder.ID, &folder.CreatedAt, &folder.UpdatedAt)

	if err != nil {
		if isPgDuplicateError(err) {
			return fmt.Errorf("folder '%s': %w", folder.Name, domain.ErrConflict)
		}
		return fmt.Errorf("create folder: %w", err)
	}

	return nil
}

// GetByID retrieves a folder by ID
func (r *PostgresFolderRepository) GetByID(ctx context.Context, id, projectID string) (*models.Folder, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, parent_id, name, created_at, updated_at
		FROM %s
		WHERE id = $1 AND project_id = $2
	`, r.tables.Folders)

	var folder models.Folder
	err := r.pool.QueryRow(ctx, query, id, projectID).Scan(
		&folder.ID,
		&folder.ProjectID,
		&folder.ParentID,
		&folder.Name,
		&folder.CreatedAt,
		&folder.UpdatedAt,
	)

	if err != nil {
		if isPgNoRowsError(err) {
			return nil, fmt.Errorf("folder %s: %w", id, domain.ErrNotFound)
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
		WHERE id = $4 AND project_id = $5
	`, r.tables.Folders)

	result, err := r.pool.Exec(ctx, query,
		folder.ParentID,
		folder.Name,
		folder.UpdatedAt,
		folder.ID,
		folder.ProjectID,
	)

	if err != nil {
		if isPgDuplicateError(err) {
			return fmt.Errorf("folder '%s': %w", folder.Name, domain.ErrConflict)
		}
		return fmt.Errorf("update folder: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("folder %s: %w", folder.ID, domain.ErrNotFound)
	}

	return nil
}

// Delete deletes a folder
func (r *PostgresFolderRepository) Delete(ctx context.Context, id, projectID string) error {
	query := fmt.Sprintf(`
		DELETE FROM %s
		WHERE id = $1 AND project_id = $2
	`, r.tables.Folders)

	result, err := r.pool.Exec(ctx, query, id, projectID)
	if err != nil {
		if isPgForeignKeyError(err) {
			return fmt.Errorf("cannot delete folder with children: %w", domain.ErrConflict)
		}
		return fmt.Errorf("delete folder: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("folder %s: %w", id, domain.ErrNotFound)
	}

	return nil
}

// ListChildren lists immediate child folders
func (r *PostgresFolderRepository) ListChildren(ctx context.Context, folderID *string, projectID string) ([]models.Folder, error) {
	var query string
	var args []interface{}

	if folderID == nil {
		query = fmt.Sprintf(`
			SELECT id, project_id, parent_id, name, created_at, updated_at
			FROM %s
			WHERE project_id = $1 AND parent_id IS NULL
			ORDER BY name ASC
		`, r.tables.Folders)
		args = append(args, projectID)
	} else {
		query = fmt.Sprintf(`
			SELECT id, project_id, parent_id, name, created_at, updated_at
			FROM %s
			WHERE project_id = $1 AND parent_id = $2
			ORDER BY name ASC
		`, r.tables.Folders)
		args = append(args, projectID, *folderID)
	}

	rows, err := r.pool.Query(ctx, query, args...)
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
			SELECT id, name, parent_id, name::text AS path
			FROM %s
			WHERE id = $1 AND project_id = $2
			UNION ALL
			SELECT f.id, f.name, f.parent_id, f.name || '/' || fp.path
			FROM %s f
			JOIN folder_path fp ON f.id = fp.parent_id
		)
		SELECT path FROM folder_path WHERE parent_id IS NULL
	`, r.tables.Folders, r.tables.Folders)

	var path string
	err := r.pool.QueryRow(ctx, query, *folderID, projectID).Scan(&path)
	if err != nil {
		if isPgNoRowsError(err) {
			return "", fmt.Errorf("folder %s: %w", *folderID, domain.ErrNotFound)
		}
		return "", fmt.Errorf("get folder path: %w", err)
	}

	return path, nil
}

// GetAllByProject retrieves all folders in a project (flat list)
func (r *PostgresFolderRepository) GetAllByProject(ctx context.Context, projectID string) ([]models.Folder, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, parent_id, name, created_at, updated_at
		FROM %s
		WHERE project_id = $1
		ORDER BY created_at ASC
	`, r.tables.Folders)

	rows, err := r.pool.Query(ctx, query, projectID)
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
		return nil, fmt.Errorf("invalid path: %w", domain.ErrValidation)
	}

	var currentParentID *string

	// Traverse path segment by segment
	for _, segment := range segments {
		folder, err := r.getFolderByNameAndParent(ctx, projectID, segment, currentParentID)
		if err != nil {
			return nil, err
		}
		if folder == nil {
			return nil, fmt.Errorf("folder at path '%s': %w", path, domain.ErrNotFound)
		}
		currentParentID = &folder.ID
	}

	if currentParentID == nil {
		return nil, fmt.Errorf("folder at path '%s': %w", path, domain.ErrNotFound)
	}

	return r.GetByID(ctx, *currentParentID, projectID)
}

// getFolderByNameAndParent is a helper to find a folder by name and parent
func (r *PostgresFolderRepository) getFolderByNameAndParent(ctx context.Context, projectID string, name string, parentID *string) (*models.Folder, error) {
	var query string
	var args []interface{}

	if parentID == nil {
		query = fmt.Sprintf(`
			SELECT id, project_id, parent_id, name, created_at, updated_at
			FROM %s
			WHERE project_id = $1 AND name = $2 AND parent_id IS NULL
		`, r.tables.Folders)
		args = append(args, projectID, name)
	} else {
		query = fmt.Sprintf(`
			SELECT id, project_id, parent_id, name, created_at, updated_at
			FROM %s
			WHERE project_id = $1 AND name = $2 AND parent_id = $3
		`, r.tables.Folders)
		args = append(args, projectID, name, *parentID)
	}

	var folder models.Folder
	err := r.pool.QueryRow(ctx, query, args...).Scan(
		&folder.ID,
		&folder.ProjectID,
		&folder.ParentID,
		&folder.Name,
		&folder.CreatedAt,
		&folder.UpdatedAt,
	)

	if err != nil {
		if isPgNoRowsError(err) {
			return nil, nil // Not found, not an error
		}
		return nil, fmt.Errorf("get folder by name and parent: %w", err)
	}

	return &folder, nil
}
