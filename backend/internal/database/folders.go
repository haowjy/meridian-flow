package database

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/jimmyyao/meridian/backend/internal/models"
	"github.com/lib/pq"
)

// CreateFolder creates a new folder
func (db *DB) CreateFolder(folder *models.Folder) error {
	// Guard against duplicates at the application level (root-level NULLs bypass unique constraints)
	existing, err := db.getFolderByNameAndParent(folder.ProjectID, folder.Name, folder.ParentID)
	if err != nil {
		return err
	}
	if existing != nil {
		return fmt.Errorf("folder '%s' already exists at this level", folder.Name)
	}

	query := fmt.Sprintf(`
		INSERT INTO %s (project_id, parent_id, name, created_at)
		VALUES ($1, $2, $3, $4)
		RETURNING id
	`, db.Tables.Folders)

	err = db.QueryRow(
		query,
		folder.ProjectID,
		folder.ParentID,
		folder.Name,
		folder.CreatedAt,
	).Scan(&folder.ID)

	if err != nil {
		// Check for unique constraint violation
		if pqErr, ok := err.(*pq.Error); ok && pqErr.Code == "23505" {
			return fmt.Errorf("folder '%s' already exists at this level", folder.Name)
		}
		return fmt.Errorf("failed to create folder: %w", err)
	}

	return nil
}

// GetFolder retrieves a single folder by ID
func (db *DB) GetFolder(id string, projectID string) (*models.Folder, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, parent_id, name, created_at
		FROM %s
		WHERE id = $1 AND project_id = $2
	`, db.Tables.Folders)

	var folder models.Folder
	err := db.QueryRow(query, id, projectID).Scan(
		&folder.ID,
		&folder.ProjectID,
		&folder.ParentID,
		&folder.Name,
		&folder.CreatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("folder not found")
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get folder: %w", err)
	}

	return &folder, nil
}

// GetFolderByPath retrieves a folder by its full path
// Path is like "Characters/Villains" (folder names separated by /)
func (db *DB) GetFolderByPath(projectID string, path string) (*models.Folder, error) {
	// Split path into segments
	segments := strings.Split(strings.Trim(path, "/"), "/")
	if len(segments) == 0 || (len(segments) == 1 && segments[0] == "") {
		return nil, fmt.Errorf("invalid path")
	}

	var currentParentID *string // Start at root (NULL)

	// Traverse path segment by segment
	for _, segment := range segments {
		folder, err := db.getFolderByNameAndParent(projectID, segment, currentParentID)
		if err != nil {
			return nil, err
		}
		if folder == nil {
			return nil, nil // Folder doesn't exist
		}
		currentParentID = &folder.ID
	}

	// Return the final folder
	if currentParentID == nil {
		return nil, nil
	}

	return db.GetFolder(*currentParentID, projectID)
}

// getFolderByNameAndParent is a helper to find a folder by name and parent
func (db *DB) getFolderByNameAndParent(projectID string, name string, parentID *string) (*models.Folder, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, parent_id, name, created_at
		FROM %s
		WHERE project_id = $1 AND name = $2 AND `, db.Tables.Folders)

	var args []interface{}
	args = append(args, projectID, name)

	if parentID == nil {
		query += "parent_id IS NULL"
	} else {
		query += "parent_id = $3"
		args = append(args, *parentID)
	}

	var folder models.Folder
	err := db.QueryRow(query, args...).Scan(
		&folder.ID,
		&folder.ProjectID,
		&folder.ParentID,
		&folder.Name,
		&folder.CreatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, nil // Not found, not an error
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get folder by name and parent: %w", err)
	}

	return &folder, nil
}

// ListFolderChildren retrieves immediate children (folders and documents) of a folder
func (db *DB) ListFolderChildren(folderID *string, projectID string) ([]models.Folder, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, parent_id, name, created_at
		FROM %s
		WHERE project_id = $1 AND `, db.Tables.Folders)

	var args []interface{}
	args = append(args, projectID)

	if folderID == nil {
		query += "parent_id IS NULL"
	} else {
		query += "parent_id = $2"
		args = append(args, *folderID)
	}

	query += " ORDER BY name ASC"

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list folder children: %w", err)
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
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan folder: %w", err)
		}
		folders = append(folders, folder)
	}

	return folders, nil
}

// UpdateFolder updates an existing folder (rename or move)
func (db *DB) UpdateFolder(folder *models.Folder) error {
	// Ensure we are not renaming/moving into a duplicate location
	existing, err := db.getFolderByNameAndParent(folder.ProjectID, folder.Name, folder.ParentID)
	if err != nil {
		return err
	}
	if existing != nil && existing.ID != folder.ID {
		return fmt.Errorf("folder '%s' already exists at this level", folder.Name)
	}

	query := fmt.Sprintf(`
		UPDATE %s
		SET name = $1, parent_id = $2
		WHERE id = $3 AND project_id = $4
	`, db.Tables.Folders)

	result, err := db.Exec(
		query,
		folder.Name,
		folder.ParentID,
		folder.ID,
		folder.ProjectID,
	)

	if err != nil {
		// Check for unique constraint violation
		if pqErr, ok := err.(*pq.Error); ok && pqErr.Code == "23505" {
			return fmt.Errorf("folder '%s' already exists at this level", folder.Name)
		}
		return fmt.Errorf("failed to update folder: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}

	if rowsAffected == 0 {
		return fmt.Errorf("folder not found")
	}

	return nil
}

// DeleteFolder deletes a folder (and cascades to children via ON DELETE CASCADE)
func (db *DB) DeleteFolder(id string, projectID string) error {
	query := fmt.Sprintf(`
		DELETE FROM %s
		WHERE id = $1 AND project_id = $2
	`, db.Tables.Folders)

	result, err := db.Exec(query, id, projectID)
	if err != nil {
		return fmt.Errorf("failed to delete folder: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}

	if rowsAffected == 0 {
		return fmt.Errorf("folder not found")
	}

	return nil
}

// GetFolderPath computes the full path of a folder from its hierarchy
// Returns path like "Characters/Villains" or "" for root-level folders
func (db *DB) GetFolderPath(folderID *string, projectID string) (string, error) {
	if folderID == nil {
		return "", nil // Root level
	}

	var pathSegments []string
	currentID := folderID

	// Traverse up the hierarchy
	for currentID != nil {
		folder, err := db.GetFolder(*currentID, projectID)
		if err != nil {
			return "", err
		}

		// Prepend this folder's name
		pathSegments = append([]string{folder.Name}, pathSegments...)

		// Move to parent
		currentID = folder.ParentID
	}

	return strings.Join(pathSegments, "/"), nil
}

// CreateFolderIfNotExists creates a folder only if it doesn't exist
// Returns the folder (existing or newly created)
func (db *DB) CreateFolderIfNotExists(projectID string, parentID *string, name string) (*models.Folder, error) {
	// Check if it exists
	existing, err := db.getFolderByNameAndParent(projectID, name, parentID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, nil // Already exists
	}

	// Create new folder
	folder := &models.Folder{
		ProjectID: projectID,
		ParentID:  parentID,
		Name:      name,
		CreatedAt: time.Now(),
	}

	err = db.CreateFolder(folder)
	if err != nil {
		return nil, err
	}

	return folder, nil
}
