package docsystem

import (
	"context"
	"fmt"
	"log/slog"

	"meridian/internal/domain"
	models "meridian/internal/domain/models/docsystem"
	docsysRepo "meridian/internal/domain/repositories/docsystem"

	"meridian/internal/repository/postgres"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresDocumentRepository implements the DocumentRepository interface
type PostgresDocumentRepository struct {
	pool   *pgxpool.Pool
	tables *postgres.TableNames
	logger *slog.Logger
}

// NewDocumentRepository creates a new document repository
func NewDocumentRepository(config *postgres.RepositoryConfig) docsysRepo.DocumentRepository {
	return &PostgresDocumentRepository{
		pool:   config.Pool,
		tables: config.Tables,
		logger: config.Logger,
	}
}

// Create creates a new document
func (r *PostgresDocumentRepository) Create(ctx context.Context, doc *models.Document) error {
	query := fmt.Sprintf(`
		INSERT INTO %s (project_id, folder_id, name, content, word_count, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, created_at, updated_at
	`, r.tables.Documents)

	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query,
		doc.ProjectID,
		doc.FolderID,
		doc.Name,
		doc.Content,
		doc.WordCount,
		doc.CreatedAt,
		doc.UpdatedAt,
	).Scan(&doc.ID, &doc.CreatedAt, &doc.UpdatedAt)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			// Query for the existing document to get its ID
			existingID, queryErr := r.getExistingDocumentID(ctx, doc.ProjectID, doc.FolderID, doc.Name)
			if queryErr != nil {
				// Fallback to generic conflict error if we can't find the existing document
				return fmt.Errorf("document '%s' already exists in this location: %w", doc.Name, domain.ErrConflict)
			}

			// Return structured conflict error with resource ID
			return &domain.ConflictError{
				Message:      fmt.Sprintf("document '%s' already exists in this location", doc.Name),
				ResourceType: "document",
				ResourceID:   existingID,
			}
		}
		return fmt.Errorf("create document: %w", err)
	}

	return nil
}

// GetByID retrieves a document by ID
func (r *PostgresDocumentRepository) GetByID(ctx context.Context, id, projectID string) (*models.Document, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, folder_id, name, content, word_count, created_at, updated_at
		FROM %s
		WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
	`, r.tables.Documents)

	var doc models.Document
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, id, projectID).Scan(
		&doc.ID,
		&doc.ProjectID,
		&doc.FolderID,
		&doc.Name,
		&doc.Content,
		&doc.WordCount,
		&doc.CreatedAt,
		&doc.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
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
		SET folder_id = $1, name = $2, content = $3, word_count = $4, updated_at = $5
		WHERE id = $6 AND project_id = $7 AND deleted_at IS NULL
	`, r.tables.Documents)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query,
		doc.FolderID,
		doc.Name,
		doc.Content,
		doc.WordCount,
		doc.UpdatedAt,
		doc.ID,
		doc.ProjectID,
	)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			// Query for the existing document to get its ID
			existingID, queryErr := r.getExistingDocumentID(ctx, doc.ProjectID, doc.FolderID, doc.Name)
			if queryErr != nil {
				// Fallback to generic conflict error if we can't find the existing document
				return fmt.Errorf("document '%s' already exists in this location: %w", doc.Name, domain.ErrConflict)
			}

			// Return structured conflict error with resource ID
			return &domain.ConflictError{
				Message:      fmt.Sprintf("document '%s' already exists in this location", doc.Name),
				ResourceType: "document",
				ResourceID:   existingID,
			}
		}
		return fmt.Errorf("update document: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("document %s: %w", doc.ID, domain.ErrNotFound)
	}

	return nil
}

// Delete soft-deletes a document by setting deleted_at timestamp
func (r *PostgresDocumentRepository) Delete(ctx context.Context, id, projectID string) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET deleted_at = NOW()
		WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
	`, r.tables.Documents)

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, id, projectID)
	if err != nil {
		return fmt.Errorf("delete document: %w", err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("document %s: %w", id, domain.ErrNotFound)
	}

	return nil
}

// DeleteAllByProject soft-deletes all documents in a project
func (r *PostgresDocumentRepository) DeleteAllByProject(ctx context.Context, projectID string) error {
	query := fmt.Sprintf(`
		UPDATE %s
		SET deleted_at = NOW()
		WHERE project_id = $1 AND deleted_at IS NULL
	`, r.tables.Documents)

	executor := postgres.GetExecutor(ctx, r.pool)
	_, err := executor.Exec(ctx, query, projectID)
	if err != nil {
		return fmt.Errorf("delete all documents: %w", err)
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
			WHERE project_id = $1 AND folder_id IS NULL AND deleted_at IS NULL
			ORDER BY name ASC
		`, r.tables.Documents)
		args = append(args, projectID)
	} else {
		query = fmt.Sprintf(`
			SELECT id, project_id, folder_id, name, word_count, updated_at
			FROM %s
			WHERE project_id = $1 AND folder_id = $2 AND deleted_at IS NULL
			ORDER BY name ASC
		`, r.tables.Documents)
		args = append(args, projectID, *folderID)
	}

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, args...)
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

	// Return empty slice instead of nil
	if documents == nil {
		documents = []models.Document{}
	}

	return documents, nil
}

// GetAllMetadataByProject retrieves all document metadata in a project (no content)
func (r *PostgresDocumentRepository) GetAllMetadataByProject(ctx context.Context, projectID string) ([]models.Document, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, folder_id, name, word_count, updated_at
		FROM %s
		WHERE project_id = $1 AND deleted_at IS NULL
		ORDER BY updated_at DESC
	`, r.tables.Documents)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, projectID)
	if err != nil {
		return nil, fmt.Errorf("get all document metadata: %w", err)
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

	// Return empty slice instead of nil
	if documents == nil {
		documents = []models.Document{}
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
			WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
			UNION ALL
			SELECT f.id, f.name, f.parent_id, f.name || '/' || fp.path
			FROM %s f
			JOIN folder_path fp ON f.id = fp.parent_id
			WHERE f.deleted_at IS NULL
		)
		SELECT path FROM folder_path WHERE parent_id IS NULL
	`, r.tables.Folders, r.tables.Folders)

	var folderPath string
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, *doc.FolderID, doc.ProjectID).Scan(&folderPath)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			// Folder not found, return just document name
			return doc.Name, nil
		}
		return "", fmt.Errorf("get folder path: %w", err)
	}

	return folderPath + "/" + doc.Name, nil
}

// getExistingDocumentID queries for an existing document by unique constraint fields
// Returns the document ID if found, error otherwise
func (r *PostgresDocumentRepository) getExistingDocumentID(ctx context.Context, projectID string, folderID *string, name string) (string, error) {
	query := fmt.Sprintf(`
		SELECT id
		FROM %s
		WHERE project_id = $1 AND name = $3
	`, r.tables.Documents)

	var id string
	var err error
	executor := postgres.GetExecutor(ctx, r.pool)

	if folderID == nil {
		// Query for root-level document (folder_id IS NULL)
		query = fmt.Sprintf(`
			SELECT id
			FROM %s
			WHERE project_id = $1 AND folder_id IS NULL AND name = $2 AND deleted_at IS NULL
		`, r.tables.Documents)
		err = executor.QueryRow(ctx, query, projectID, name).Scan(&id)
	} else {
		// Query for document in specific folder
		query = fmt.Sprintf(`
			SELECT id
			FROM %s
			WHERE project_id = $1 AND folder_id = $2 AND name = $3 AND deleted_at IS NULL
		`, r.tables.Documents)
		err = executor.QueryRow(ctx, query, projectID, *folderID, name).Scan(&id)
	}

	if err != nil {
		return "", fmt.Errorf("get existing document ID: %w", err)
	}

	return id, nil
}
