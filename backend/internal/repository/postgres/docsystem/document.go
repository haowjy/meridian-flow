package docsystem

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
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
		INSERT INTO %s (project_id, folder_id, name, extension, content, metadata, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, created_at, updated_at
	`, r.tables.Documents)

	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query,
		doc.ProjectID,
		doc.FolderID,
		doc.Name,
		doc.Extension,
		doc.Content,
		doc.Metadata,
		doc.CreatedAt,
		doc.UpdatedAt,
	).Scan(&doc.ID, &doc.CreatedAt, &doc.UpdatedAt)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			// Query for the existing document to get its ID
			existingID, queryErr := r.getExistingDocumentID(ctx, doc.ProjectID, doc.FolderID, doc.Name, doc.Extension)
			if queryErr != nil {
				// Return ConflictError directly (query failed - document may be soft-deleted)
				return &domain.ConflictError{
					Message:      fmt.Sprintf("document '%s' already exists in this location", doc.Filename()),
					ResourceType: "document",
					ResourceID:   "", // Unknown ID since query failed
				}
			}

			// Return structured conflict error with resource ID
			return &domain.ConflictError{
				Message:      fmt.Sprintf("document '%s' already exists in this location", doc.Filename()),
				ResourceType: "document",
				ResourceID:   existingID,
			}
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

		return fmt.Errorf("create document: %w", err)
	}

	return nil
}

// GetByID retrieves a document by ID
func (r *PostgresDocumentRepository) GetByID(ctx context.Context, id, projectID string) (*models.Document, error) {
	var query string
	var args []interface{}

	if projectID != "" {
		query = fmt.Sprintf(`
			SELECT id, project_id, folder_id, name, extension, content, metadata, created_at, updated_at
			FROM %s
			WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
		`, r.tables.Documents)
		args = []interface{}{id, projectID}
	} else {
		query = fmt.Sprintf(`
			SELECT id, project_id, folder_id, name, extension, content, metadata, created_at, updated_at
			FROM %s
			WHERE id = $1 AND deleted_at IS NULL
		`, r.tables.Documents)
		args = []interface{}{id}
	}

	var doc models.Document
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, args...).Scan(
		&doc.ID,
		&doc.ProjectID,
		&doc.FolderID,
		&doc.Name,
		&doc.Extension,
		&doc.Content,
		&doc.Metadata,
		&doc.CreatedAt,
		&doc.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("document",
				fmt.Sprintf("document %s not found", id))
		}
		return nil, fmt.Errorf("get document: %w", err)
	}

	doc.EnsureMetadata()
	return &doc, nil
}

// GetByIDOnly retrieves a document by UUID only (no project scoping)
// Use when authorization is handled separately (e.g., by ResourceAuthorizer)
func (r *PostgresDocumentRepository) GetByIDOnly(ctx context.Context, id string) (*models.Document, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, folder_id, name, extension, content, metadata, created_at, updated_at
		FROM %s
		WHERE id = $1 AND deleted_at IS NULL
	`, r.tables.Documents)

	var doc models.Document
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, id).Scan(
		&doc.ID,
		&doc.ProjectID,
		&doc.FolderID,
		&doc.Name,
		&doc.Extension,
		&doc.Content,
		&doc.Metadata,
		&doc.CreatedAt,
		&doc.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("document",
				fmt.Sprintf("document %s not found", id))
		}
		return nil, fmt.Errorf("get document: %w", err)
	}

	doc.EnsureMetadata()
	return &doc, nil
}

// GetByPath retrieves a document by its path (e.g., ".meridian/skills/my-skill/references/guide.md")
// The path includes the full filename with extension
func (r *PostgresDocumentRepository) GetByPath(ctx context.Context, path string, projectID string) (*models.Document, error) {
	// Split path into parts
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 0 {
		return nil, domain.NewValidationError("invalid path: path cannot be empty")
	}

	// Last part is the filename (name + extension)
	filename := parts[len(parts)-1]
	folderParts := parts[:len(parts)-1]

	// Split filename into name and extension
	// Handle edge cases: "file.md", "file.tar.gz" (take last extension), "file" (no extension)
	lastDot := strings.LastIndex(filename, ".")
	var docName, extension string
	if lastDot > 0 {
		docName = filename[:lastDot]
		extension = filename[lastDot:] // includes the dot
	} else {
		docName = filename
		extension = ".md" // default extension
	}

	// Find the folder by walking the path
	var folderID *string
	for _, folderName := range folderParts {
		folder, err := r.findFolderByName(ctx, projectID, folderID, folderName)
		if err != nil {
			return nil, fmt.Errorf("folder '%s' not found: %w", folderName, err)
		}
		folderID = &folder.ID
	}

	// Query for the document in the final folder
	query := fmt.Sprintf(`
		SELECT id, project_id, folder_id, name, extension, content, metadata, created_at, updated_at
		FROM %s
		WHERE project_id = $1 AND name = $2 AND extension = $3 AND deleted_at IS NULL
	`, r.tables.Documents)

	args := []interface{}{projectID, docName, extension}

	// Add folder_id condition
	if folderID != nil {
		query += ` AND folder_id = $4`
		args = append(args, *folderID)
	} else {
		query += ` AND folder_id IS NULL`
	}

	var doc models.Document
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, args...).Scan(
		&doc.ID,
		&doc.ProjectID,
		&doc.FolderID,
		&doc.Name,
		&doc.Extension,
		&doc.Content,
		&doc.Metadata,
		&doc.CreatedAt,
		&doc.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("document",
				fmt.Sprintf("document at path '%s' not found", path))
		}
		return nil, fmt.Errorf("get document by path: %w", err)
	}

	doc.EnsureMetadata()
	return &doc, nil
}

// findFolderByName finds a folder by name within a parent folder
func (r *PostgresDocumentRepository) findFolderByName(ctx context.Context, projectID string, parentID *string, name string) (*models.Folder, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, parent_id, name, created_at, updated_at
		FROM %s
		WHERE project_id = $1 AND name = $2 AND deleted_at IS NULL
	`, r.tables.Folders)

	args := []interface{}{projectID, name}

	// Add parent_id condition
	if parentID != nil {
		query += ` AND parent_id = $3`
		args = append(args, *parentID)
	} else {
		query += ` AND parent_id IS NULL`
	}

	var folder models.Folder
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, args...).Scan(
		&folder.ID,
		&folder.ProjectID,
		&folder.ParentID,
		&folder.Name,
		&folder.CreatedAt,
		&folder.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, domain.NewNotFoundError("folder",
				fmt.Sprintf("folder '%s' not found", name))
		}
		return nil, fmt.Errorf("find folder by name: %w", err)
	}

	return &folder, nil
}

// Update updates an existing document
func (r *PostgresDocumentRepository) Update(ctx context.Context, doc *models.Document) error {
	var query string
	var args []interface{}
	if doc.ProjectID != "" {
		query = fmt.Sprintf(`
			UPDATE %s
			SET folder_id = $1, name = $2, extension = $3, content = $4, metadata = $5, updated_at = $6
			WHERE id = $7 AND project_id = $8 AND deleted_at IS NULL
		`, r.tables.Documents)
		args = []interface{}{
			doc.FolderID,
			doc.Name,
			doc.Extension,
			doc.Content,
			doc.Metadata,
			doc.UpdatedAt,
			doc.ID,
			doc.ProjectID,
		}
	} else {
		query = fmt.Sprintf(`
			UPDATE %s
			SET folder_id = $1, name = $2, extension = $3, content = $4, metadata = $5, updated_at = $6
			WHERE id = $7 AND deleted_at IS NULL
		`, r.tables.Documents)
		args = []interface{}{
			doc.FolderID,
			doc.Name,
			doc.Extension,
			doc.Content,
			doc.Metadata,
			doc.UpdatedAt,
			doc.ID,
		}
	}

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, args...)

	if err != nil {
		if postgres.IsPgDuplicateError(err) {
			// Query for the existing document to get its ID
			existingID, queryErr := r.getExistingDocumentID(ctx, doc.ProjectID, doc.FolderID, doc.Name, doc.Extension)
			if queryErr != nil {
				// Return ConflictError directly (query failed - document may be soft-deleted)
				return &domain.ConflictError{
					Message:      fmt.Sprintf("document '%s' already exists in this location", doc.Filename()),
					ResourceType: "document",
					ResourceID:   "", // Unknown ID since query failed
				}
			}

			// Return structured conflict error with resource ID
			return &domain.ConflictError{
				Message:      fmt.Sprintf("document '%s' already exists in this location", doc.Filename()),
				ResourceType: "document",
				ResourceID:   existingID,
			}
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

		return fmt.Errorf("update document: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.NewNotFoundError("document",
			fmt.Sprintf("document %s not found", doc.ID))
	}

	return nil
}

// Delete soft-deletes a document by setting deleted_at timestamp
func (r *PostgresDocumentRepository) Delete(ctx context.Context, id, projectID string) error {
	var query string
	var args []interface{}

	if projectID != "" {
		query = fmt.Sprintf(`
			UPDATE %s
			SET deleted_at = NOW()
			WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
		`, r.tables.Documents)
		args = []interface{}{id, projectID}
	} else {
		query = fmt.Sprintf(`
			UPDATE %s
			SET deleted_at = NOW()
			WHERE id = $1 AND deleted_at IS NULL
		`, r.tables.Documents)
		args = []interface{}{id}
	}

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("delete document: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.NewNotFoundError("document",
			fmt.Sprintf("document %s not found", id))
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
			SELECT id, project_id, folder_id, name, extension, metadata, updated_at
			FROM %s
			WHERE project_id = $1 AND folder_id IS NULL AND deleted_at IS NULL
			ORDER BY name ASC, extension ASC
		`, r.tables.Documents)
		args = append(args, projectID)
	} else {
		query = fmt.Sprintf(`
			SELECT id, project_id, folder_id, name, extension, metadata, updated_at
			FROM %s
			WHERE project_id = $1 AND folder_id = $2 AND deleted_at IS NULL
			ORDER BY name ASC, extension ASC
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
			&doc.Extension,
			&doc.Metadata,
			&doc.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan document: %w", err)
		}
		doc.EnsureMetadata()
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
		SELECT
			d.id,
			d.project_id,
			d.folder_id,
			d.name,
			d.extension,
			d.metadata,
			d.updated_at,
			COALESCE(pp.pending_proposal_count, 0) AS pending_proposal_count
		FROM %s d
		LEFT JOIN (
			SELECT
				document_id,
				COUNT(*)::int AS pending_proposal_count
			FROM %s
			WHERE status = $2
			GROUP BY document_id
		) pp ON pp.document_id = d.id
		WHERE d.project_id = $1 AND d.deleted_at IS NULL
		ORDER BY d.updated_at DESC
	`, r.tables.Documents, r.tables.CollabDocumentProposals)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, projectID, collabModels.ProposalStatusPending)
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
			&doc.Extension,
			&doc.Metadata,
			&doc.UpdatedAt,
			&doc.PendingProposalCount,
		)
		if err != nil {
			return nil, fmt.Errorf("scan document: %w", err)
		}
		doc.EnsureMetadata()
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

// GetPath computes the full display path for a document (folder path + filename)
func (r *PostgresDocumentRepository) GetPath(ctx context.Context, doc *models.Document) (string, error) {
	if doc.FolderID == nil {
		// Root level document - path is just the filename (name + extension)
		return doc.Filename(), nil
	}

	// Get folder's full path using recursive CTE
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

	var folderPath string
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, query, *doc.FolderID, doc.ProjectID).Scan(&folderPath)
	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			// Folder not found, return just filename
			return doc.Filename(), nil
		}
		return "", fmt.Errorf("get folder path: %w", err)
	}

	// Append filename to folder path
	return folderPath + "/" + doc.Filename(), nil
}

// getExistingDocumentID queries for an existing document by unique constraint fields
// Returns the document ID if found, error otherwise
func (r *PostgresDocumentRepository) getExistingDocumentID(ctx context.Context, projectID string, folderID *string, name string, extension string) (string, error) {
	var id string
	executor := postgres.GetExecutor(ctx, r.pool)

	var err error
	if folderID == nil {
		// Query for root-level document (folder_id IS NULL)
		query := fmt.Sprintf(`
			SELECT id FROM %s
			WHERE project_id = $1 AND folder_id IS NULL AND name = $2 AND extension = $3 AND deleted_at IS NULL
		`, r.tables.Documents)
		err = executor.QueryRow(ctx, query, projectID, name, extension).Scan(&id)
	} else {
		// Query for document in specific folder
		query := fmt.Sprintf(`
			SELECT id FROM %s
			WHERE project_id = $1 AND folder_id = $2 AND name = $3 AND extension = $4 AND deleted_at IS NULL
		`, r.tables.Documents)
		err = executor.QueryRow(ctx, query, projectID, *folderID, name, extension).Scan(&id)
	}

	if err != nil {
		return "", fmt.Errorf("get existing document ID: %w", err)
	}

	return id, nil
}

// SearchDocuments performs full-text search on document content
// Currently supports only SearchStrategyFullText
func (r *PostgresDocumentRepository) SearchDocuments(ctx context.Context, options *models.SearchOptions) (*models.SearchResults, error) {
	// Apply defaults and validate
	options.ApplyDefaults()
	if err := options.Validate(); err != nil {
		return nil, fmt.Errorf("invalid search options: %w", err)
	}

	// Route to appropriate search implementation
	switch options.Strategy {
	case models.SearchStrategyFullText:
		return r.fullTextSearch(ctx, options)
	case models.SearchStrategyVector:
		return nil, fmt.Errorf("vector search not yet implemented")
	case models.SearchStrategyHybrid:
		return nil, fmt.Errorf("hybrid search not yet implemented")
	default:
		return nil, fmt.Errorf("unknown search strategy: %s", options.Strategy)
	}
}

// fullTextSearch implements PostgreSQL full-text search with configurable language and fields
func (r *PostgresDocumentRepository) fullTextSearch(ctx context.Context, opts *models.SearchOptions) (*models.SearchResults, error) {
	// Build dynamic search query based on which fields to search
	// PostgreSQL full-text search components:
	// - to_tsvector(language, field): Converts field to searchable tokens
	// - websearch_to_tsquery(language, query): Converts query with Google-like syntax (OR, NOT, phrases)
	// - @@: Full-text match operator
	// - ts_rank(): Ranks results by relevance (higher = better match)
	//
	// Field weighting:
	// - name matches: 2.0x multiplier (more important)
	// - content matches: 1.0x multiplier (normal weight)

	// Build field-specific search conditions and rank expressions
	var searchConditions []string
	var rankExpressions []string

	for _, field := range opts.Fields {
		switch field {
		case models.SearchFieldName:
			// Search in name/title field
			searchConditions = append(searchConditions,
				"to_tsvector($1, name) @@ websearch_to_tsquery($1, $2)")
			// Weight title matches 2x higher
			rankExpressions = append(rankExpressions,
				"ts_rank(to_tsvector($1, name), websearch_to_tsquery($1, $2)) * 2.0")

		case models.SearchFieldContent:
			// Search in content field
			searchConditions = append(searchConditions,
				"to_tsvector($1, content) @@ websearch_to_tsquery($1, $2)")
			// Normal weight
			rankExpressions = append(rankExpressions,
				"ts_rank(to_tsvector($1, content), websearch_to_tsquery($1, $2))")
		}
	}

	// Combine conditions with OR (matches if ANY field matches)
	whereClause := strings.Join(searchConditions, " OR ")

	// Sum rank expressions for combined score
	rankExpression := strings.Join(rankExpressions, " + ")

	baseQuery := fmt.Sprintf(`
		SELECT id, project_id, folder_id, name, extension,
		       ts_headline($1, content, websearch_to_tsquery($1, $2),
		                   'MaxWords=50, MinWords=20, MaxFragments=1') AS content,
		       metadata, created_at, updated_at,
		       (%s) AS rank_score
		FROM %s
		WHERE deleted_at IS NULL
		  AND (%s)
	`, rankExpression, r.tables.Documents, whereClause)

	args := []interface{}{opts.Language, opts.Query}
	paramIndex := 3

	// Add optional project filter
	if opts.ProjectID != "" {
		baseQuery += fmt.Sprintf(` AND project_id = $%d`, paramIndex)
		args = append(args, opts.ProjectID)
		paramIndex++
	}

	// Add optional folder filter
	if opts.FolderID != nil {
		baseQuery += fmt.Sprintf(` AND folder_id = $%d`, paramIndex)
		args = append(args, *opts.FolderID)
		paramIndex++
	}

	// Order by relevance score (descending)
	baseQuery += ` ORDER BY rank_score DESC`

	// Add pagination
	baseQuery += fmt.Sprintf(` LIMIT $%d OFFSET $%d`, paramIndex, paramIndex+1)
	args = append(args, opts.Limit, opts.Offset)

	// Execute search query
	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, baseQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("full-text search query failed: %w", err)
	}
	defer rows.Close()

	// Collect results with scores
	var searchResults []models.SearchResult
	for rows.Next() {
		var doc models.Document
		var score float64

		err := rows.Scan(
			&doc.ID,
			&doc.ProjectID,
			&doc.FolderID,
			&doc.Name,
			&doc.Extension,
			&doc.Content,
			&doc.Metadata,
			&doc.CreatedAt,
			&doc.UpdatedAt,
			&score,
		)
		if err != nil {
			return nil, fmt.Errorf("scan search result: %w", err)
		}
		doc.EnsureMetadata()

		searchResults = append(searchResults, models.SearchResult{
			Document: doc,
			Score:    score,
			Metadata: map[string]interface{}{
				"rank_method": "ts_rank",
				"language":    opts.Language,
			},
		})
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate search results: %w", err)
	}

	// Return empty slice instead of nil
	if searchResults == nil {
		searchResults = []models.SearchResult{}
	}

	// Get total count for pagination metadata
	totalCount, err := r.countTotalMatches(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("count total matches: %w", err)
	}

	// Build results with pagination metadata
	results := models.NewSearchResults(searchResults, totalCount, opts)

	return results, nil
}

// countTotalMatches counts total matching documents (without limit/offset)
func (r *PostgresDocumentRepository) countTotalMatches(ctx context.Context, opts *models.SearchOptions) (int, error) {
	// Build same search conditions as fullTextSearch
	var searchConditions []string

	for _, field := range opts.Fields {
		switch field {
		case models.SearchFieldName:
			searchConditions = append(searchConditions,
				"to_tsvector($1, name) @@ websearch_to_tsquery($1, $2)")
		case models.SearchFieldContent:
			searchConditions = append(searchConditions,
				"to_tsvector($1, content) @@ websearch_to_tsquery($1, $2)")
		}
	}

	whereClause := strings.Join(searchConditions, " OR ")

	countQuery := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM %s
		WHERE deleted_at IS NULL
		  AND (%s)
	`, r.tables.Documents, whereClause)

	args := []interface{}{opts.Language, opts.Query}
	paramIndex := 3

	// Add optional project filter
	if opts.ProjectID != "" {
		countQuery += fmt.Sprintf(` AND project_id = $%d`, paramIndex)
		args = append(args, opts.ProjectID)
		paramIndex++
	}

	// Add optional folder filter
	if opts.FolderID != nil {
		countQuery += fmt.Sprintf(` AND folder_id = $%d`, paramIndex)
		args = append(args, *opts.FolderID)
	}

	var total int
	executor := postgres.GetExecutor(ctx, r.pool)
	err := executor.QueryRow(ctx, countQuery, args...).Scan(&total)
	if err != nil {
		return 0, fmt.Errorf("count query failed: %w", err)
	}

	return total, nil
}

// GetAllByFolderRecursive returns all documents in a folder and all its descendant folders.
// Uses a recursive CTE to find all descendant folders, then joins with documents.
func (r *PostgresDocumentRepository) GetAllByFolderRecursive(ctx context.Context, folderID, projectID string) ([]models.Document, error) {
	// Recursive CTE to get all descendant folder IDs (including the folder itself)
	query := fmt.Sprintf(`
		WITH RECURSIVE folder_descendants AS (
			-- Base case: the folder itself
			SELECT id FROM %s
			WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
			UNION ALL
			-- Recursive case: all children
			SELECT f.id
			FROM %s f
			JOIN folder_descendants fd ON f.parent_id = fd.id
			WHERE f.deleted_at IS NULL
		)
		SELECT d.id, d.project_id, d.folder_id, d.name, d.extension, d.metadata, d.updated_at
		FROM %s d
		JOIN folder_descendants fd ON d.folder_id = fd.id
		WHERE d.project_id = $2 AND d.deleted_at IS NULL
		ORDER BY d.updated_at DESC
	`, r.tables.Folders, r.tables.Folders, r.tables.Documents)

	executor := postgres.GetExecutor(ctx, r.pool)
	rows, err := executor.Query(ctx, query, folderID, projectID)
	if err != nil {
		return nil, fmt.Errorf("get documents by folder recursive: %w", err)
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
			&doc.Extension,
			&doc.Metadata,
			&doc.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan document: %w", err)
		}
		doc.EnsureMetadata()
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
