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
	docsysSvc "meridian/internal/domain/services/docsystem"
)

// documentService implements the DocumentService interface
type documentService struct {
	docRepo         docsysRepo.DocumentRepository
	folderRepo      docsysRepo.FolderRepository
	txManager       repositories.TransactionManager
	contentAnalyzer docsysSvc.ContentAnalyzer
	pathResolver    docsysSvc.PathResolver
	validator       *ResourceValidator
	logger          *slog.Logger
}

// NewDocumentService creates a new document service
func NewDocumentService(
	docRepo docsysRepo.DocumentRepository,
	folderRepo docsysRepo.FolderRepository,
	txManager repositories.TransactionManager,
	contentAnalyzer docsysSvc.ContentAnalyzer,
	pathResolver docsysSvc.PathResolver,
	validator *ResourceValidator,
	logger *slog.Logger,
) docsysSvc.DocumentService {
	return &documentService{
		docRepo:         docRepo,
		folderRepo:      folderRepo,
		txManager:       txManager,
		contentAnalyzer: contentAnalyzer,
		pathResolver:    pathResolver,
		validator:       validator,
		logger:          logger,
	}
}

// CreateDocument creates a new document with priority-based folder resolution
// Supports Unix-style path notation in name field:
//   - "name.md" → create document with given name at folder_id
//   - "a/b/c.md" → auto-create intermediate folders (a, b) and document (c.md) at folder_id
//   - "/a/b/c.md" → absolute path from root (ignore folder_id)
func (s *documentService) CreateDocument(ctx context.Context, req *docsysSvc.CreateDocumentRequest) (*models.Document, error) {
	// Normalize empty string folder_id to nil for root-level documents
	if req.FolderID != nil && *req.FolderID == "" {
		req.FolderID = nil
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
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	folderID := result.ResolvedFolderID
	docName := result.FinalName

	s.logger.Debug("path notation resolved",
		"original_name", req.Name,
		"final_name", docName,
		"folder_id", folderID,
	)

	// Count words (business logic)
	wordCount := s.contentAnalyzer.CountWords(req.Content)

	// Create document
	doc := &models.Document{
		ProjectID: req.ProjectID,
		FolderID:  folderID,
		Name:      docName,
		Content:   req.Content,
		WordCount: wordCount,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := s.docRepo.Create(ctx, doc); err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.docRepo.GetPath(ctx, doc)
	if err != nil {
		s.logger.Warn("failed to compute path", "doc_id", doc.ID, "error", err)
		doc.Path = docName
	} else {
		doc.Path = path
	}

	s.logger.Info("document created",
		"id", doc.ID,
		"name", doc.Name,
		"project_id", req.ProjectID,
		"folder_id", folderID,
		"word_count", wordCount,
		"path_notation", IsPathNotation(req.Name),
	)

	return doc, nil
}

// GetDocument retrieves a document with its computed path
func (s *documentService) GetDocument(ctx context.Context, id, projectID string) (*models.Document, error) {
	doc, err := s.docRepo.GetByID(ctx, id, projectID)
	if err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.docRepo.GetPath(ctx, doc)
	if err != nil {
		s.logger.Warn("failed to compute path", "doc_id", doc.ID, "error", err)
		doc.Path = doc.Name
	} else {
		doc.Path = path
	}

	return doc, nil
}

// UpdateDocument updates a document
func (s *documentService) UpdateDocument(ctx context.Context, id string, req *docsysSvc.UpdateDocumentRequest) (*models.Document, error) {
	// Get existing document
	doc, err := s.docRepo.GetByID(ctx, id, req.ProjectID)
	if err != nil {
		return nil, err
	}

	// Update fields
	if req.Name != nil {
		trimmedName := strings.TrimSpace(*req.Name)
		// Validate name doesn't contain slashes
		if strings.Contains(trimmedName, "/") {
			return nil, fmt.Errorf("%w: document name cannot contain slashes", domain.ErrValidation)
		}
		doc.Name = trimmedName
	}

	// Priority-based folder resolution for moving documents:
	// 1. Try folder_id first (frontend optimization - direct lookup)
	// 2. Fall back to folder_path (external AI - resolve/auto-create)
	// 3. Neither = don't move document
	if req.FolderID != nil {
		// Validate target folder exists and is not deleted
		targetFolderID := *req.FolderID
		if targetFolderID != "" { // Empty string means root, which is always valid
			if err := s.validator.ValidateFolder(ctx, targetFolderID, req.ProjectID); err != nil {
				return nil, err
			}
		}
		// Frontend optimization: use provided folder_id directly
		doc.FolderID = req.FolderID
	} else if req.FolderPath != nil {
		// External AI: resolve folder path, creating folders if needed
		resolvedFolder, err := s.pathResolver.ResolveFolderPath(ctx, req.ProjectID, *req.FolderPath)
		if err != nil {
			return nil, err
		}
		// Validate resolved folder exists and is not deleted (if not root)
		if resolvedFolder != nil && *resolvedFolder != "" {
			if err := s.validator.ValidateFolder(ctx, *resolvedFolder, req.ProjectID); err != nil {
				return nil, err
			}
		}
		doc.FolderID = resolvedFolder
	}
	// If neither provided: keep current folder location

	if req.Content != nil {
		doc.Content = *req.Content
		// Recalculate word count
		doc.WordCount = s.contentAnalyzer.CountWords(doc.Content)
	}

	doc.UpdatedAt = time.Now()

	// Update in database
	if err := s.docRepo.Update(ctx, doc); err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.docRepo.GetPath(ctx, doc)
	if err != nil {
		s.logger.Warn("failed to compute path", "doc_id", doc.ID, "error", err)
		doc.Path = doc.Name
	} else {
		doc.Path = path
	}

	s.logger.Info("document updated",
		"id", doc.ID,
		"name", doc.Name,
		"project_id", req.ProjectID,
	)

	return doc, nil
}

// DeleteDocument deletes a document
func (s *documentService) DeleteDocument(ctx context.Context, id, projectID string) error {
	if err := s.docRepo.Delete(ctx, id, projectID); err != nil {
		return err
	}

	s.logger.Info("document deleted",
		"id", id,
		"project_id", projectID,
	)

	return nil
}

// SearchDocuments performs full-text search across documents with path computation
func (s *documentService) SearchDocuments(ctx context.Context, req *docsysSvc.SearchDocumentsRequest) (*models.SearchResults, error) {
	// Validate request
	if req.Query == "" {
		return nil, fmt.Errorf("%w: search query cannot be empty", domain.ErrValidation)
	}

	// TODO: Add permission check
	// If projectID is specified, verify user has access to that project
	// If projectID is empty, search will naturally be limited to user's projects
	// when we add user_id to documents table or project membership checks

	// Convert string fields to SearchField enum
	var fields []models.SearchField
	for _, f := range req.Fields {
		switch f {
		case "name":
			fields = append(fields, models.SearchFieldName)
		case "content":
			fields = append(fields, models.SearchFieldContent)
		default:
			return nil, fmt.Errorf("%w: invalid search field %q (supported: name, content)", domain.ErrValidation, f)
		}
	}

	// Convert request to repository SearchOptions
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
			s.logger.Warn("failed to compute path for search result",
				"doc_id", doc.ID,
				"error", err,
			)
			doc.Path = doc.Name // Fallback to just the name
		} else {
			doc.Path = path
		}
	}

	return results, nil
}
