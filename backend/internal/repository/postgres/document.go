package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jimmyyao/meridian/backend/internal/domain"
	"github.com/jimmyyao/meridian/backend/internal/domain/models"
	"github.com/jimmyyao/meridian/backend/internal/domain/repositories"
)

// PostgresDocumentRepository implements the DocumentRepository interface
type PostgresDocumentRepository struct {
	pool   *pgxpool.Pool
	tables *TableNames
}

// NewDocumentRepository creates a new document repository
func NewDocumentRepository(config *RepositoryConfig) repositories.DocumentRepository {
	return &PostgresDocumentRepository{
		pool:   config.Pool,
		tables: config.Tables,
	}
}

// Create creates a new document
func (r *PostgresDocumentRepository) Create(ctx context.Context, doc *models.Document) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (project_id, folder_id, name, content_tiptap, content_markdown, word_count, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, created_at, updated_at
	`, r.tables.Documents)

	err := r.pool.QueryRow(ctx, query,
		doc.ProjectID,
		doc.FolderID,
		doc.Name,
		doc.ContentTipTap, // pgx handles JSONB natively
		doc.ContentMarkdown,
		doc.WordCount,
		doc.CreatedAt,
		doc.UpdatedAt,
	).Scan(&doc.ID, &doc.CreatedAt, &doc.UpdatedAt)

	if err != nil {
		if isPgDuplicateError(err) {
			return fmt.Errorf("document '%s' already exists in this location: %w", doc.Name, domain.ErrConflict)
		}
		return fmt.Errorf("create document: %w", err)
	}

	return nil
}

// GetByID retrieves a document by ID
func (r *PostgresDocumentRepository) GetByID(ctx context.Context, id, projectID string) (*models.Document, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, folder_id, name, content_tiptap, content_markdown, word_count, created_at, updated_at
		FROM %s
		WHERE id = $1 AND project_id = $2
	`, r.tables.Documents)

	var doc models.Document
	err := r.pool.QueryRow(ctx, query, id, projectID).Scan(
		&doc.ID,
		&doc.ProjectID,
		&doc.FolderID,
		&doc.Name,
		&doc.ContentTipTap, // pgx handles JSONB natively
		&doc.ContentMarkdown,
		&doc.WordCount,
		&doc.CreatedAt,
		&doc.UpdatedAt,
	)

	if err != nil {
		if isPgNoRowsError(err) {
			return nil, fmt.Errorf("document %s: %w", id, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("get document: %w", err)
	}

	return &doc, nil
}

// Update updates an existing document
func (r *PostgresDocumentRepository) Update(ctx context.Context, doc *models.Document) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET folder_id = $1, name = $2, content_tiptap = $3, content_markdown = $4, word_count = $5, updated_at = $6
		WHERE id = $7 AND project_id = $8
	`, r.tables.Documents)

	result, err := r.pool.Exec(ctx, query,
		doc.FolderID,
		doc.Name,
		doc.ContentTipTap, // pgx handles JSONB natively
		doc.ContentMarkdown,
		doc.WordCount,
		doc.UpdatedAt,
		doc.ID,
		doc.ProjectID,
	)

	if err != nil {
		if isPgDuplicateError(err) {
			return fmt.Errorf("document '%s' already exists in this location: %w", doc.Name, domain.ErrConflict)
		}
		return fmt.Errorf("update document: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("document %s: %w", doc.ID, domain.ErrNotFound)
	}

	return nil
}

// Delete deletes a document
func (r *PostgresDocumentRepository) Delete(ctx context.Context, id, projectID string) error {
	query := fmt.Sprintf(`
		DELETE FROM %s
		WHERE id = $1 AND project_id = $2
	`, r.tables.Documents)

	result, err := r.pool.Exec(ctx, query, id, projectID)
	if err != nil {
		return fmt.Errorf("delete document: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("document %s: %w", id, domain.ErrNotFound)
	}

	return nil
}

// ListByFolder lists documents in a folder
func (r *PostgresDocumentRepository) ListByFolder(ctx context.Context, folderID *string, projectID string) ([]models.Document, error) {
	var query string
	var args []interface{}

	if folderID == nil {
		query = fmt.Sprintf(`
			SELECT id, project_id, folder_id, name, word_count, updated_at
			FROM %s
			WHERE project_id = $1 AND folder_id IS NULL
			ORDER BY name ASC
		`, r.tables.Documents)
		args = append(args, projectID)
	} else {
		query = fmt.Sprintf(`
			SELECT id, project_id, folder_id, name, word_count, updated_at
			FROM %s
			WHERE project_id = $1 AND folder_id = $2
			ORDER BY name ASC
		`, r.tables.Documents)
		args = append(args, projectID, *folderID)
	}

	rows, err := r.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list documents in folder: %w", err)
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
			return nil, fmt.Errorf("scan document: %w", err)
		}
		documents = append(documents, doc)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate documents: %w", err)
	}

	return documents, nil
}

// GetPath computes the display path for a document
func (r *PostgresDocumentRepository) GetPath(ctx context.Context, doc *models.Document) (string, error) {
	if doc.FolderID == nil {
		// Root level document
		return doc.Name, nil
	}

	// Get folder path using recursive CTE
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

	var folderPath string
	err := r.pool.QueryRow(ctx, query, *doc.FolderID, doc.ProjectID).Scan(&folderPath)
	if err != nil {
		if isPgNoRowsError(err) {
			// Folder not found, return just document name
			return doc.Name, nil
		}
		return "", fmt.Errorf("get folder path: %w", err)
	}

	return folderPath + "/" + doc.Name, nil
}
