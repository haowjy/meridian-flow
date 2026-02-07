package docsystem

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"meridian/internal/config"
	"meridian/internal/domain"
	models "meridian/internal/domain/models/docsystem"
	"meridian/internal/domain/repositories"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	"meridian/internal/domain/services"
	docsysSvc "meridian/internal/domain/services/docsystem"
)

// documentService implements the DocumentService interface
type documentService struct {
	docRepo         docsysRepo.DocumentRepository
	folderRepo      docsysRepo.FolderRepository
	projectRepo     docsysRepo.ProjectRepository
	txManager       repositories.TransactionManager
	contentAnalyzer docsysSvc.ContentAnalyzer
	pathResolver    docsysSvc.PathResolver
	validator       *ResourceValidator
	authorizer      services.ResourceAuthorizer
	logger          *slog.Logger
}

// NewDocumentService creates a new document service
func NewDocumentService(
	docRepo docsysRepo.DocumentRepository,
	folderRepo docsysRepo.FolderRepository,
	projectRepo docsysRepo.ProjectRepository,
	txManager repositories.TransactionManager,
	contentAnalyzer docsysSvc.ContentAnalyzer,
	pathResolver docsysSvc.PathResolver,
	validator *ResourceValidator,
	authorizer services.ResourceAuthorizer,
	logger *slog.Logger,
) docsysSvc.DocumentService {
	return &documentService{
		docRepo:         docRepo,
		folderRepo:      folderRepo,
		projectRepo:     projectRepo,
		txManager:       txManager,
		contentAnalyzer: contentAnalyzer,
		pathResolver:    pathResolver,
		validator:       validator,
		authorizer:      authorizer,
		logger:          logger,
	}
}

// CreateDocument creates a new document with priority-based folder resolution
// Supports Unix-style path notation in name field:
//   - "name" → create document with given name at folder_id
//   - "a/b/c" → auto-create intermediate folders (a, b) and document (c) at folder_id
//   - "/a/b/c" → absolute path from root (ignore folder_id)
func (s *documentService) CreateDocument(ctx context.Context, req *docsysSvc.CreateDocumentRequest) (*models.Document, error) {
	// Normalize empty string folder_id to nil for root-level documents
	if req.FolderID != nil && *req.FolderID == "" {
		req.FolderID = nil
	}

	// Normalize and validate extension
	extension := models.NormalizeExtension(req.Extension)
	if !models.IsValidExtension(extension) {
		return nil, fmt.Errorf("%w: unsupported file extension %q (supported: %v)",
			domain.ErrValidation, extension, models.ValidExtensions())
	}

	// Validate parent resources are not deleted
	if err := s.validator.ValidateProject(ctx, req.ProjectID, req.UserID); err != nil {
		return nil, err
	}
	if req.FolderID != nil {
		if err := s.validator.ValidateFolder(ctx, *req.FolderID, req.ProjectID); err != nil {
			return nil, err
		}
	}

	// Use path notation resolver to handle all path logic (unified)
	result, err := s.pathResolver.ResolvePathNotation(ctx, &docsysSvc.PathNotationRequest{
		ProjectID:     req.ProjectID,
		Name:          req.Name,
		FolderID:      req.FolderID,
		FolderPath:    req.FolderPath,
		MaxNameLength: config.MaxDocumentNameLength,
	})
	if err != nil {
		return nil, domain.NewValidationError(fmt.Sprintf("path resolution failed: %v", err))
	}

	folderID := result.ResolvedFolderID
	docName := result.FinalName

	s.logger.Debug("path notation resolved",
		"original_name", req.Name,
		"final_name", docName,
		"extension", extension,
		"folder_id", folderID,
	)

	// Check for duplicate name+extension in target folder
	siblings, err := s.docRepo.ListByFolder(ctx, folderID, req.ProjectID)
	if err != nil {
		return nil, err // Pass through HTTPError directly
	}
	for _, sibling := range siblings {
		if sibling.Name == docName && sibling.Extension == extension {
			return nil, &domain.ConflictError{
				Message:      fmt.Sprintf("a document named %q already exists in this folder", docName+extension),
				ResourceType: "document",
				ResourceID:   sibling.ID,
			}
		}
	}

	// Create document
	doc := &models.Document{
		ProjectID: req.ProjectID,
		FolderID:  folderID,
		Name:      docName,
		Extension: extension,
		Content:   req.Content,
		Metadata:  models.DocumentMetadata{},
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	// Compute format-specific metadata based on file category
	// Only markdown-family files get word count
	if models.IsMarkdownExtension(extension) {
		doc.SetMarkdownWordCount(s.contentAnalyzer.CountWords(req.Content))
	}

	if err := s.docRepo.Create(ctx, doc); err != nil {
		return nil, err
	}

	// Touch project activity (non-fatal - don't fail document creation for metadata updates)
	if err := s.projectRepo.TouchLastActivityAt(ctx, req.ProjectID); err != nil {
		s.logger.Warn("failed to touch project activity",
			"project_id", req.ProjectID,
			"error", err,
		)
	}

	// Compute display path
	path, err := s.docRepo.GetPath(ctx, doc)
	if err != nil {
		s.logger.Warn("failed to compute path", "doc_id", doc.ID, "error", err)
		doc.Path = doc.Filename()
	} else {
		doc.Path = path
	}

	s.logger.Info("document created",
		"id", doc.ID,
		"name", doc.Name,
		"path", doc.Path,
		"extension", doc.Extension,
		"project_id", req.ProjectID,
		"folder_id", folderID,
		"word_count", doc.WordCount(),
		"path_notation", IsPathNotation(req.Name),
	)

	return doc, nil
}

// GetDocument retrieves a document with its computed path
// Authorization is checked first via the injected authorizer
func (s *documentService) GetDocument(ctx context.Context, userID, documentID string) (*models.Document, error) {
	// Authorize: check user can access this document
	if err := s.authorizer.CanAccessDocument(ctx, userID, documentID); err != nil {
		return nil, err
	}

	// Get document (authorization already done, use GetByIDOnly)
	doc, err := s.docRepo.GetByIDOnly(ctx, documentID)
	if err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.docRepo.GetPath(ctx, doc)
	if err != nil {
		s.logger.Warn("failed to compute path", "doc_id", doc.ID, "error", err)
		doc.Path = doc.Filename()
	} else {
		doc.Path = path
	}

	return doc, nil
}

// UpdateDocument updates a document
// Authorization is checked first via the injected authorizer
func (s *documentService) UpdateDocument(ctx context.Context, userID, documentID string, req *docsysSvc.UpdateDocumentRequest) (*models.Document, error) {
	// Authorize: check user can access this document
	if err := s.authorizer.CanAccessDocument(ctx, userID, documentID); err != nil {
		return nil, err
	}

	// Get existing document (authorization already done, use GetByIDOnly)
	doc, err := s.docRepo.GetByIDOnly(ctx, documentID)
	if err != nil {
		return nil, err
	}

	// Update fields
	if req.Name != nil {
		trimmedName := strings.TrimSpace(*req.Name)
		// Validate name doesn't contain slashes
		if strings.Contains(trimmedName, "/") {
			return nil, domain.NewValidationErrorWithField(
				"document name cannot contain slashes", "name")
		}
		doc.Name = trimmedName
	}

	// Update extension if provided
	if req.Extension != nil {
		extension := models.NormalizeExtension(*req.Extension)
		if !models.IsValidExtension(extension) {
			return nil, fmt.Errorf("%w: unsupported file extension %q (supported: %v)",
				domain.ErrValidation, extension, models.ValidExtensions())
		}
		doc.Extension = extension
	}

	// Priority-based folder resolution for moving documents:
	// 1. Try folder_id first (tri-state: absent=don't change, null=root, value=folder)
	// 2. Fall back to folder_path (external AI - resolve/auto-create)
	// 3. Neither = don't move document
	originalFolderID := doc.FolderID
	if req.FolderID.Present {
		if req.FolderID.Value != nil {
			// Move to specified folder - validate it exists and is not deleted
			if err := s.validator.ValidateFolder(ctx, *req.FolderID.Value, doc.ProjectID); err != nil {
				return nil, err
			}
			doc.FolderID = req.FolderID.Value
		} else {
			// null = move to root
			doc.FolderID = nil
		}
	} else if req.FolderPath != nil {
		// External AI: resolve folder path, creating folders if needed
		resolvedFolder, err := s.pathResolver.ResolveFolderPath(ctx, doc.ProjectID, *req.FolderPath)
		if err != nil {
			return nil, err
		}
		// Validate resolved folder exists and is not deleted (if not root)
		if resolvedFolder != nil && *resolvedFolder != "" {
			if err := s.validator.ValidateFolder(ctx, *resolvedFolder, doc.ProjectID); err != nil {
				return nil, err
			}
		}
		doc.FolderID = resolvedFolder
	}
	// Note: We no longer track folder changes for slug updates since slugs are removed.
	// Path is computed on-the-fly when retrieving documents.
	_ = originalFolderID // Silence unused variable warning

	if req.Content != nil {
		doc.Content = *req.Content
	}

	// Unified word count recalculation — placed AFTER all field mutations (content, extension,
	// ai_version) so the count reflects the effective document state.
	// When ai_version exists, word count should reflect ai_version (the latest text the user sees).
	if models.IsMarkdownExtension(doc.Extension) {
		// Determine effective content for word count:
		// - If ai_version is being SET in this request → use that value
		// - If ai_version is being CLEARED → fall back to doc.Content
		// - If ai_version is unchanged and exists on doc → use existing ai_version
		// - If ai_version is unchanged and absent → use doc.Content
		effectiveContent := doc.Content
		if req.AIVersion.Present {
			if req.AIVersion.Value != nil {
				effectiveContent = *req.AIVersion.Value
			}
			// else: being cleared → effectiveContent stays as doc.Content
		} else if doc.AIVersion != nil {
			effectiveContent = *doc.AIVersion
		}
		doc.SetMarkdownWordCount(s.contentAnalyzer.CountWords(effectiveContent))
	} else {
		doc.ClearMarkdownMetadata()
	}

	// Check for duplicate name+extension in target folder (if name, extension, or folder changed)
	if req.Name != nil || req.Extension != nil || req.FolderID.Present || req.FolderPath != nil {
		siblings, err := s.docRepo.ListByFolder(ctx, doc.FolderID, doc.ProjectID)
		if err != nil {
			return nil, err // Pass through HTTPError directly
		}
		for _, sibling := range siblings {
			if sibling.ID != doc.ID && sibling.Name == doc.Name && sibling.Extension == doc.Extension {
				return nil, &domain.ConflictError{
					Message:      fmt.Sprintf("a document named %q already exists in this folder", doc.Filename()),
					ResourceType: "document",
					ResourceID:   sibling.ID,
				}
			}
		}
	}

	doc.UpdatedAt = time.Now()

	// If ai_version is being updated, use CAS (compare-and-swap) for concurrency safety
	if req.AIVersion.Present {
		var result *models.Document
		err := s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
			// Update document fields first (name, folder, content)
			if err := s.docRepo.Update(txCtx, doc); err != nil {
				return err
			}

			// Atomic CAS update for ai_version with revision check
			rowsAffected, err := s.docRepo.UpdateWithAIVersionCheck(txCtx, docsysRepo.UpdateWithAIVersionParams{
				ID:               documentID,
				AIVersion:        req.AIVersion.Value,
				AIVersionBaseRev: req.AIVersionBaseRev,
				// Other fields already updated above, pass nil to skip (COALESCE keeps current)
			})
			if err != nil {
				return err
			}
			if rowsAffected == 0 {
				// CAS failed - ai_version_rev mismatch
				// Fetch current doc to include in conflict response
				currentDoc, fetchErr := s.docRepo.GetByIDOnly(txCtx, documentID)
				if fetchErr != nil {
					s.logger.Debug("failed to fetch doc for conflict response", "doc_id", documentID, "error", fetchErr)
				}
				return &domain.AIVersionConflictError{
					Message:  "ai_version was modified since last fetch",
					Document: currentDoc,
				}
			}

			// Re-fetch for consistent response (captures updated timestamps)
			fetched, err := s.docRepo.GetByIDOnly(txCtx, documentID)
			if err != nil {
				return err
			}
			result = fetched
			return nil
		})
		if err != nil {
			return nil, err
		}

		// Touch project activity when content changes (non-fatal, outside tx)
		if req.Content != nil {
			if err := s.projectRepo.TouchLastActivityAt(ctx, result.ProjectID); err != nil {
				s.logger.Warn("failed to touch project activity",
					"project_id", result.ProjectID,
					"error", err,
				)
			}
		}

		// Compute display path (outside tx, non-critical)
		path, err := s.docRepo.GetPath(ctx, result)
		if err != nil {
			s.logger.Warn("failed to compute path", "doc_id", result.ID, "error", err)
			result.Path = result.Filename()
		} else {
			result.Path = path
		}

		action := "updated"
		if req.AIVersion.Value == nil {
			action = "cleared"
		}
		s.logger.Debug("document updated with ai_version "+action,
			"id", result.ID,
			"name", result.Name,
			"project_id", result.ProjectID,
		)

		return result, nil
	}

	// Non-transactional path (no ai_version change)
	if err := s.docRepo.Update(ctx, doc); err != nil {
		return nil, err
	}

	// Touch project activity when content changes (non-fatal)
	if req.Content != nil {
		if err := s.projectRepo.TouchLastActivityAt(ctx, doc.ProjectID); err != nil {
			s.logger.Warn("failed to touch project activity",
				"project_id", doc.ProjectID,
				"error", err,
			)
		}
	}

	// Compute display path
	path, err := s.docRepo.GetPath(ctx, doc)
	if err != nil {
		s.logger.Warn("failed to compute path", "doc_id", doc.ID, "error", err)
		doc.Path = doc.Filename()
	} else {
		doc.Path = path
	}

	s.logger.Debug("document updated",
		"id", doc.ID,
		"name", doc.Name,
		"project_id", doc.ProjectID,
	)

	return doc, nil
}

// UpdateAIVersion updates the ai_version field for a document
// Authorization is checked first via the injected authorizer
// Pass nil to clear ai_version (reject suggestions)
func (s *documentService) UpdateAIVersion(ctx context.Context, userID, documentID string, aiVersion *string) (*models.Document, error) {
	// Authorize: check user can access this document
	if err := s.authorizer.CanAccessDocument(ctx, userID, documentID); err != nil {
		return nil, err
	}

	// Fetch document to compute word count from effective content
	doc, err := s.docRepo.GetByIDOnly(ctx, documentID)
	if err != nil {
		return nil, err
	}
	if doc == nil {
		return nil, fmt.Errorf("document not found: %s", documentID)
	}

	// Recalculate word count from effective content:
	// - If setting ai_version, count words from new ai_version
	// - If clearing ai_version (nil), fall back to doc.Content
	doc.EnsureMetadata()
	if models.IsMarkdownExtension(doc.Extension) {
		effectiveContent := doc.Content
		if aiVersion != nil {
			effectiveContent = *aiVersion
		}
		doc.SetMarkdownWordCount(s.contentAnalyzer.CountWords(effectiveContent))
	}

	// Persist ai_version + metadata atomically; RETURNING gives us consistent timestamps
	doc, err = s.docRepo.UpdateAIVersion(ctx, documentID, aiVersion, doc.Metadata)
	if err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.docRepo.GetPath(ctx, doc)
	if err != nil {
		s.logger.Warn("failed to compute path", "doc_id", doc.ID, "error", err)
		doc.Path = doc.Filename()
	} else {
		doc.Path = path
	}

	action := "updated"
	if aiVersion == nil {
		action = "cleared"
	}
	s.logger.Debug("document ai_version "+action,
		"id", doc.ID,
		"project_id", doc.ProjectID,
	)

	return doc, nil
}

// DeleteDocument deletes a document
// Authorization is checked first via the injected authorizer
func (s *documentService) DeleteDocument(ctx context.Context, userID, documentID string) error {
	// Authorize: check user can access this document
	if err := s.authorizer.CanAccessDocument(ctx, userID, documentID); err != nil {
		return err
	}

	// Get document (authorization already done, use GetByIDOnly)
	doc, err := s.docRepo.GetByIDOnly(ctx, documentID)
	if err != nil {
		return err
	}

	if err := s.docRepo.Delete(ctx, documentID, doc.ProjectID); err != nil {
		return err
	}

	// Touch project activity (non-fatal)
	if err := s.projectRepo.TouchLastActivityAt(ctx, doc.ProjectID); err != nil {
		s.logger.Warn("failed to touch project activity",
			"project_id", doc.ProjectID,
			"error", err,
		)
	}

	s.logger.Info("document deleted",
		"id", documentID,
		"project_id", doc.ProjectID,
	)

	return nil
}

// SearchDocuments performs full-text search across documents with path computation
// userID is required for authorization - verifies user can access the project
func (s *documentService) SearchDocuments(ctx context.Context, userID string, req *docsysSvc.SearchDocumentsRequest) (*models.SearchResults, error) {
	// Validate request
	if req.Query == "" {
		return nil, domain.NewValidationErrorWithField(
			"search query cannot be empty", "query")
	}

	// Require projectID for authorization (cross-project search not yet supported)
	if req.ProjectID == "" {
		return nil, domain.NewValidationErrorWithField(
			"project_id is required for search", "project_id")
	}

	// Verify user has access to this project
	if err := s.authorizer.CanAccessProject(ctx, userID, req.ProjectID); err != nil {
		return nil, err
	}

	// Convert string fields to SearchField enum
	var fields []models.SearchField
	for _, f := range req.Fields {
		switch f {
		case "name":
			fields = append(fields, models.SearchFieldName)
		case "content":
			fields = append(fields, models.SearchFieldContent)
		default:
			return nil, domain.NewValidationErrorWithField(
				fmt.Sprintf("invalid search field %q (supported: name, content)", f), "fields")
		}
	}

	// Convert request to repository SearchOptions
	// Authorization already verified above via CanAccessProject
	opts := &models.SearchOptions{
		Query:     req.Query,
		ProjectID: req.ProjectID,
		Fields:    fields, // Will default to [name, content] in ApplyDefaults() if empty
		Limit:     req.Limit,
		Offset:    req.Offset,
		Language:  req.Language,
		FolderID:  req.FolderID,
		Strategy:  models.SearchStrategyFullText, // Always use fulltext for now
	}

	// Call repository search
	results, err := s.docRepo.SearchDocuments(ctx, opts)
	if err != nil {
		return nil, err
	}

	// Compute paths for all documents (business logic)
	for i := range results.Results {
		doc := &results.Results[i].Document
		path, err := s.docRepo.GetPath(ctx, doc)
		if err != nil {
			// Log warning but don't fail the entire search
			s.logger.Debug("failed to compute path for search result",
				"doc_id", doc.ID,
				"error", err,
			)
			doc.Path = doc.Filename() // Fallback to just the name
		} else {
			doc.Path = path
		}
	}

	return results, nil
}

// GetDocumentByPath retrieves a document by its Unix-style path within a project.
// userID is required for authorization - verifies user can access the project.
// path is the Unix-style document path (e.g., "/Characters/Aria.md").
func (s *documentService) GetDocumentByPath(ctx context.Context, userID, path, projectID string) (*models.Document, error) {
	// Authorize: check user can access this project
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	// Get document by path (repo call)
	doc, err := s.docRepo.GetByPath(ctx, path, projectID)
	if err != nil {
		return nil, err
	}

	// Compute display path
	docPath, err := s.docRepo.GetPath(ctx, doc)
	if err != nil {
		s.logger.Warn("failed to compute path", "doc_id", doc.ID, "error", err)
		doc.Path = doc.Filename()
	} else {
		doc.Path = docPath
	}

	return doc, nil
}
