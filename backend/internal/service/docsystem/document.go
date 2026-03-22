package docsystem

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"meridian/internal/config"
	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	domaindocsys "meridian/internal/domain/docsystem"
)

// documentService implements the DocumentService interface
type documentService struct {
	docRepo         domaindocsys.DocumentStore
	folderRepo      domaindocsys.FolderStore
	projectRepo     domaindocsys.ProjectStore
	txManager       domain.TransactionManager
	contentAnalyzer domaindocsys.ContentAnalyzer
	pathResolver    domaindocsys.PathNotationResolver
	validator       *ResourceValidator
	authorizer      authdomain.ResourceAuthorizer
	logger          *slog.Logger
}

var _ domaindocsys.DocumentService = (*documentService)(nil)

// NewDocumentService creates a new document service
func NewDocumentService(
	docRepo domaindocsys.DocumentStore,
	folderRepo domaindocsys.FolderStore,
	projectRepo domaindocsys.ProjectStore,
	txManager domain.TransactionManager,
	contentAnalyzer domaindocsys.ContentAnalyzer,
	pathResolver domaindocsys.PathNotationResolver,
	validator *ResourceValidator,
	authorizer authdomain.ResourceAuthorizer,
	logger *slog.Logger,
) domaindocsys.DocumentService {
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
//   - "name" -> create document with given name at folder_id
//   - "a/b/c" -> auto-create intermediate folders (a, b) and document (c) at folder_id
//   - "/a/b/c" -> absolute path from root (ignore folder_id)
func (s *documentService) CreateDocument(ctx context.Context, req *domaindocsys.CreateDocumentRequest) (*domaindocsys.Document, error) {
	// Normalize empty string folder_id to nil for root-level documents
	if req.FolderID != nil && *req.FolderID == "" {
		req.FolderID = nil
	}

	// Normalize and validate extension
	extension := domaindocsys.NormalizeExtension(req.Extension)
	if !domaindocsys.IsValidExtension(extension) {
		return nil, fmt.Errorf("%w: unsupported file extension %q (supported: %v)",
			domain.ErrValidation, extension, domaindocsys.ValidExtensions())
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
	result, err := s.pathResolver.ResolvePathNotation(ctx, &domaindocsys.PathNotationRequest{
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
	doc := &domaindocsys.Document{
		ProjectID: req.ProjectID,
		FolderID:  folderID,
		Name:      docName,
		Extension: extension,
		FileType:  string(domaindocsys.FileTypeFromExtension(extension)),
		Content:   req.Content,
		Metadata:  domaindocsys.DocumentMetadata{},
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	// Compute format-specific metadata based on file category
	// Only markdown-family files get word count
	if domaindocsys.IsMarkdownExtension(extension) {
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
func (s *documentService) GetDocument(ctx context.Context, userID, documentID string) (*domaindocsys.Document, error) {
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
func (s *documentService) UpdateDocument(ctx context.Context, userID, documentID string, req *domaindocsys.UpdateDocumentRequest) (*domaindocsys.Document, error) {
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
		extension := domaindocsys.NormalizeExtension(*req.Extension)
		if !domaindocsys.IsValidExtension(extension) {
			return nil, fmt.Errorf("%w: unsupported file extension %q (supported: %v)",
				domain.ErrValidation, extension, domaindocsys.ValidExtensions())
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

	// Word count recalculation — placed AFTER all field mutations (content, extension)
	if domaindocsys.IsMarkdownExtension(doc.Extension) {
		doc.SetMarkdownWordCount(s.contentAnalyzer.CountWords(doc.Content))
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
func (s *documentService) SearchDocuments(ctx context.Context, userID string, req *domaindocsys.SearchDocumentsRequest) (*domaindocsys.SearchResults, error) {
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
	var fields []domaindocsys.SearchField
	for _, f := range req.Fields {
		switch f {
		case "name":
			fields = append(fields, domaindocsys.SearchFieldName)
		case "content":
			fields = append(fields, domaindocsys.SearchFieldContent)
		default:
			return nil, domain.NewValidationErrorWithField(
				fmt.Sprintf("invalid search field %q (supported: name, content)", f), "fields")
		}
	}

	// Convert request to repository SearchOptions
	// Authorization already verified above via CanAccessProject
	opts := &domaindocsys.SearchOptions{
		Query:     req.Query,
		ProjectID: req.ProjectID,
		Fields:    fields, // Will default to [name, content] in ApplyDefaults() if empty
		Limit:     req.Limit,
		Offset:    req.Offset,
		Language:  req.Language,
		FolderID:  req.FolderID,
		Strategy:  domaindocsys.SearchStrategyFullText, // Always use fulltext for now
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
func (s *documentService) GetDocumentByPath(ctx context.Context, userID, path, projectID string) (*domaindocsys.Document, error) {
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
