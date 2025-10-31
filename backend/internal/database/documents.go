package database

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jimmyyao/meridian/backend/internal/models"
	"github.com/lib/pq"
)

// CreateDocument creates a new document
func (db *DB) CreateDocument(doc *models.Document) error {
	contentJSON, err := json.Marshal(doc.ContentTipTap)
	if err != nil {
		return fmt.Errorf("failed to marshal content: %w", err)
	}

	query := fmt.Sprintf(`
		INSERT INTO %s (project_id, folder_id, name, content_tiptap, content_markdown, word_count, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id
	`, db.Tables.Documents)

	err = db.QueryRow(
		query,
		doc.ProjectID,
		doc.FolderID,
		doc.Name,
		contentJSON,
		doc.ContentMarkdown,
		doc.WordCount,
		doc.CreatedAt,
		doc.UpdatedAt,
	).Scan(&doc.ID)

	if err != nil {
		// Check for unique constraint violation
		if pqErr, ok := err.(*pq.Error); ok && pqErr.Code == "23505" {
			return fmt.Errorf("document '%s' already exists in this location", doc.Name)
		}
		return fmt.Errorf("failed to create document: %w", err)
	}

	return nil
}

// GetDocument retrieves a single document by ID (with full content)
func (db *DB) GetDocument(id string, projectID string) (*models.Document, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, folder_id, name, content_tiptap, content_markdown, word_count, created_at, updated_at
		FROM %s
		WHERE id = $1 AND project_id = $2
	`, db.Tables.Documents)

	var doc models.Document
	var contentJSON []byte

	err := db.QueryRow(query, id, projectID).Scan(
		&doc.ID,
		&doc.ProjectID,
		&doc.FolderID,
		&doc.Name,
		&contentJSON,
		&doc.ContentMarkdown,
		&doc.WordCount,
		&doc.CreatedAt,
		&doc.UpdatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("document not found")
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get document: %w", err)
	}

	// Unmarshal JSON content
	if err := json.Unmarshal(contentJSON, &doc.ContentTipTap); err != nil {
		return nil, fmt.Errorf("failed to unmarshal content: %w", err)
	}

	// Compute display path
	path, err := db.GetDocumentPath(&doc)
	if err != nil {
		// Don't fail the request, just log and leave path empty
		fmt.Printf("Warning: failed to compute path for document %s: %v\n", doc.ID, err)
		doc.Path = doc.Name
	} else {
		doc.Path = path
	}

	return &doc, nil
}

// GetDocumentPath computes the full display path for a document
// Example: "Characters/Villains/Boss"
func (db *DB) GetDocumentPath(doc *models.Document) (string, error) {
	if doc.FolderID == nil {
		// Root level document
		return doc.Name, nil
	}

	// Get folder path
	folderPath, err := db.GetFolderPath(doc.FolderID, doc.ProjectID)
	if err != nil {
		return "", err
	}

	if folderPath == "" {
		return doc.Name, nil
	}

	return folderPath + "/" + doc.Name, nil
}

// UpdateDocument updates an existing document
// Supports updating content, name, or folder_id (moving document)
func (db *DB) UpdateDocument(doc *models.Document) error {
	contentJSON, err := json.Marshal(doc.ContentTipTap)
	if err != nil {
		return fmt.Errorf("failed to marshal content: %w", err)
	}

	query := fmt.Sprintf(`
		UPDATE %s
		SET folder_id = $1, name = $2, content_tiptap = $3, content_markdown = $4, word_count = $5, updated_at = $6
		WHERE id = $7 AND project_id = $8
	`, db.Tables.Documents)

	result, err := db.Exec(
		query,
		doc.FolderID,
		doc.Name,
		contentJSON,
		doc.ContentMarkdown,
		doc.WordCount,
		doc.UpdatedAt,
		doc.ID,
		doc.ProjectID,
	)

	if err != nil {
		// Check for unique constraint violation
		if pqErr, ok := err.(*pq.Error); ok && pqErr.Code == "23505" {
			return fmt.Errorf("document '%s' already exists in this location", doc.Name)
		}
		return fmt.Errorf("failed to update document: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}

	if rowsAffected == 0 {
		return fmt.Errorf("document not found")
	}

	return nil
}

// DeleteDocument deletes a document
func (db *DB) DeleteDocument(id string, projectID string) error {
	query := fmt.Sprintf(`
		DELETE FROM %s
		WHERE id = $1 AND project_id = $2
	`, db.Tables.Documents)

	result, err := db.Exec(query, id, projectID)
	if err != nil {
		return fmt.Errorf("failed to delete document: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to get rows affected: %w", err)
	}

	if rowsAffected == 0 {
		return fmt.Errorf("document not found")
	}

	return nil
}

// ListDocumentsInFolder retrieves all documents in a specific folder (metadata only)
func (db *DB) ListDocumentsInFolder(folderID *string, projectID string) ([]models.Document, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, folder_id, name, word_count, updated_at
		FROM %s
		WHERE project_id = $1 AND `, db.Tables.Documents)

	var args []interface{}
	args = append(args, projectID)

	if folderID == nil {
		query += "folder_id IS NULL"
	} else {
		query += "folder_id = $2"
		args = append(args, *folderID)
	}

	query += " ORDER BY name ASC"

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to list documents in folder: %w", err)
	}
	defer rows.Close()

	var documents []models.Document
	for rows.Next() {
		var doc models.Document
		err := rows.Scan(
			&doc.ID,
			&doc.ProjectID,
			&doc.FolderID,
			&doc.Name,
			&doc.WordCount,
			&doc.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan document: %w", err)
		}
		documents = append(documents, doc)
	}

	return documents, nil
}

// ClearDocumentsInProject deletes all documents in a project (for seeding)
func (db *DB) ClearDocumentsInProject(projectID string) error {
	query := fmt.Sprintf(`
		DELETE FROM %s
		WHERE project_id = $1
	`, db.Tables.Documents)

	_, err := db.Exec(query, projectID)
	if err != nil {
		return fmt.Errorf("failed to clear documents: %w", err)
	}

	return nil
}

// ClearFoldersInProject deletes all folders in a project (for seeding)
func (db *DB) ClearFoldersInProject(projectID string) error {
	query := fmt.Sprintf(`
		DELETE FROM %s
		WHERE project_id = $1
	`, db.Tables.Folders)

	_, err := db.Exec(query, projectID)
	if err != nil {
		return fmt.Errorf("failed to clear folders: %w", err)
	}

	return nil
}

// EnsureTestProject creates a test project if it doesn't exist
func (db *DB) EnsureTestProject(projectID, userID, name string) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (id, user_id, name, created_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (id) DO NOTHING
	`, db.Tables.Projects)

	_, err := db.Exec(query, projectID, userID, name, time.Now())
	if err != nil {
		return fmt.Errorf("failed to ensure test project: %w", err)
	}

	return nil
}
