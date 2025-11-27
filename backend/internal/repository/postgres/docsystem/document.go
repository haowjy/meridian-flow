package docsystem

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

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
	var query string
	var args []interface{}

	if projectID != "" {
		query = fmt.Sprintf(`
			SELECT id, project_id, folder_id, name, content, word_count, created_at, updated_at
			FROM %s
			WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
		`, r.tables.Documents)
		args = []interface{}{id, projectID}
	} else {
		query = fmt.Sprintf(`
			SELECT id, project_id, folder_id, name, content, word_count, created_at, updated_at
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

// GetByIDOnly retrieves a document by UUID only (no project scoping)
// Use when authorization is handled separately (e.g., by ResourceAuthorizer)
func (r *PostgresDocumentRepository) GetByIDOnly(ctx context.Context, id string) (*models.Document, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, folder_id, name, content, word_count, created_at, updated_at
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

// GetByPath retrieves a document by its path (e.g., ".skills/cw-prose-writing/SKILL.md")
func (r *PostgresDocumentRepository) GetByPath(ctx context.Context, path string, projectID string) (*models.Document, error) {
	// Split path into parts
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 0 {
		return nil, fmt.Errorf("invalid path: %w", domain.ErrNotFound)
	}

	// Last part is the document name
	docName := parts[len(parts)-1]
	folderParts := parts[:len(parts)-1]

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
		SELECT id, project_id, folder_id, name, content, word_count, created_at, updated_at
		FROM %s
		WHERE project_id = $1 AND name = $2 AND deleted_at IS NULL
	`, r.tables.Documents)

	args := []interface{}{projectID, docName}

	// Add folder_id condition
	if folderID != nil {
		query += ` AND folder_id = $3`
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
		&doc.Content,
		&doc.WordCount,
		&doc.CreatedAt,
		&doc.UpdatedAt,
	)

	if err != nil {
		if postgres.IsPgNoRowsError(err) {
			return nil, fmt.Errorf("document at path '%s': %w", path, domain.ErrNotFound)
		}
		return nil, fmt.Errorf("get document by path: %w", err)
	}

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
			return nil, fmt.Errorf("folder '%s': %w", name, domain.ErrNotFound)
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
			SET folder_id = $1, name = $2, content = $3, word_count = $4, updated_at = $5
			WHERE id = $6 AND project_id = $7 AND deleted_at IS NULL
		`, r.tables.Documents)
		args = []interface{}{
			doc.FolderID,
			doc.Name,
			doc.Content,
			doc.WordCount,
			doc.UpdatedAt,
			doc.ID,
			doc.ProjectID,
		}
	} else {
		query = fmt.Sprintf(`
			UPDATE %s
			SET folder_id = $1, name = $2, content = $3, word_count = $4, updated_at = $5
			WHERE id = $6 AND deleted_at IS NULL
		`, r.tables.Documents)
		args = []interface{}{
			doc.FolderID,
			doc.Name,
			doc.Content,
			doc.WordCount,
			doc.UpdatedAt,
			doc.ID,
		}
	}

	executor := postgres.GetExecutor(ctx, r.pool)
	result, err := executor.Exec(ctx, query, args...)

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

// GetPath computes the full display path for a document (folder path + document name)
func (r *PostgresDocumentRepository) GetPath(ctx context.Context, doc *models.Document) (string, error) {
	if doc.FolderID == nil {
		// Root level document - path is just the document name
		return doc.Name, nil
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
			// Folder not found, return just document name
			return doc.Name, nil
		}
		return "", fmt.Errorf("get folder path: %w", err)
	}

	// Append document name to folder path
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
		SELECT id, project_id, folder_id, name,
		       ts_headline($1, content, websearch_to_tsquery($1, $2),
		                   'MaxWords=50, MinWords=20, MaxFragments=1') AS content,
		       word_count, created_at, updated_at,
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
			&doc.Content,
			&doc.WordCount,
			&doc.CreatedAt,
			&doc.UpdatedAt,
			&score,
		)
		if err != nil {
			return nil, fmt.Errorf("scan search result: %w", err)
		}

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
