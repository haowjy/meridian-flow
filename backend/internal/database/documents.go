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
		INSERT INTO %s (project_id, path, content_tiptap, content_markdown, word_count, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id
	`, db.Tables.Documents)

	err = db.QueryRow(
		query,
		doc.ProjectID,
		doc.Path,
		contentJSON,
		doc.ContentMarkdown,
		doc.WordCount,
		doc.CreatedAt,
		doc.UpdatedAt,
	).Scan(&doc.ID)

	if err != nil {
		// Check for unique constraint violation
		if pqErr, ok := err.(*pq.Error); ok && pqErr.Code == "23505" {
			return fmt.Errorf("document with path '%s' already exists in this project", doc.Path)
		}
		return fmt.Errorf("failed to create document: %w", err)
	}

	return nil
}

// GetDocument retrieves a single document by ID
func (db *DB) GetDocument(id string, projectID string) (*models.Document, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, path, content_tiptap, content_markdown, word_count, created_at, updated_at
		FROM %s
		WHERE id = $1 AND project_id = $2
	`, db.Tables.Documents)

	var doc models.Document
	var contentJSON []byte

	err := db.QueryRow(query, id, projectID).Scan(
		&doc.ID,
		&doc.ProjectID,
		&doc.Path,
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

	return &doc, nil
}

// ListDocuments retrieves all documents in a project
func (db *DB) ListDocuments(projectID string) ([]models.Document, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, path, content_tiptap, content_markdown, word_count, created_at, updated_at
		FROM %s
		WHERE project_id = $1
		ORDER BY created_at DESC
	`, db.Tables.Documents)

	rows, err := db.Query(query, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list documents: %w", err)
	}
	defer rows.Close()

	var documents []models.Document

	for rows.Next() {
		var doc models.Document
		var contentJSON []byte

		err := rows.Scan(
			&doc.ID,
			&doc.ProjectID,
			&doc.Path,
			&contentJSON,
			&doc.ContentMarkdown,
			&doc.WordCount,
			&doc.CreatedAt,
			&doc.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan document: %w", err)
		}

		// Unmarshal JSON content
		if err := json.Unmarshal(contentJSON, &doc.ContentTipTap); err != nil {
			return nil, fmt.Errorf("failed to unmarshal content: %w", err)
		}

		documents = append(documents, doc)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating documents: %w", err)
	}

	return documents, nil
}

// UpdateDocument updates an existing document
func (db *DB) UpdateDocument(doc *models.Document) error {
	contentJSON, err := json.Marshal(doc.ContentTipTap)
	if err != nil {
		return fmt.Errorf("failed to marshal content: %w", err)
	}

	query := fmt.Sprintf(`
		UPDATE %s
		SET path = $1, content_tiptap = $2, content_markdown = $3, word_count = $4, updated_at = $5
		WHERE id = $6 AND project_id = $7
	`, db.Tables.Documents)

	result, err := db.Exec(
		query,
		doc.Path,
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
			return fmt.Errorf("document with path '%s' already exists in this project", doc.Path)
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

// GetDocumentByPath retrieves a document by path
func (db *DB) GetDocumentByPath(path string, projectID string) (*models.Document, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, path, content_tiptap, content_markdown, word_count, created_at, updated_at
		FROM %s
		WHERE path = $1 AND project_id = $2
	`, db.Tables.Documents)

	var doc models.Document
	var contentJSON []byte

	err := db.QueryRow(query, path, projectID).Scan(
		&doc.ID,
		&doc.ProjectID,
		&doc.Path,
		&contentJSON,
		&doc.ContentMarkdown,
		&doc.WordCount,
		&doc.CreatedAt,
		&doc.UpdatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, nil // Return nil if not found (not an error for this use case)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get document by path: %w", err)
	}

	// Unmarshal JSON content
	if err := json.Unmarshal(contentJSON, &doc.ContentTipTap); err != nil {
		return nil, fmt.Errorf("failed to unmarshal content: %w", err)
	}

	return &doc, nil
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

