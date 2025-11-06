package service

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	validation "github.com/go-ozzo/ozzo-validation/v4"
	"meridian/internal/config"
	"meridian/internal/domain"
	"meridian/internal/domain/models"
	"meridian/internal/domain/repositories"
	"meridian/internal/domain/services"
)

// documentService implements the DocumentService interface
type documentService struct {
	docRepo          repositories.DocumentRepository
	folderRepo       repositories.FolderRepository
	txManager        repositories.TransactionManager
	contentAnalyzer  services.ContentAnalyzer
	pathResolver     services.PathResolver
	logger           *slog.Logger
}

// NewDocumentService creates a new document service
func NewDocumentService(
	docRepo repositories.DocumentRepository,
	folderRepo repositories.FolderRepository,
	txManager repositories.TransactionManager,
	contentAnalyzer services.ContentAnalyzer,
	pathResolver services.PathResolver,
	logger *slog.Logger,
) services.DocumentService {
	return &documentService{
		docRepo:         docRepo,
		folderRepo:      folderRepo,
		txManager:       txManager,
		contentAnalyzer: contentAnalyzer,
		pathResolver:    pathResolver,
		logger:          logger,
	}
}

// CreateDocument creates a new document with priority-based folder resolution
func (s *documentService) CreateDocument(ctx context.Context, req *services.CreateDocumentRequest) (*models.Document, error) {
	// Validate request
	if err := s.validateCreateRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Normalize empty string folder_id to nil for root-level documents (consistent with UPDATE)
	// Note: folder_path already handles empty string in resolveFolderPath
	if req.FolderID != nil && *req.FolderID == "" {
		req.FolderID = nil
	}

	var folderID *string
	docName := req.Name

	// Priority-based folder resolution:
	// 1. Try folder_id first (frontend optimization - direct lookup)
	// 2. Fall back to folder_path (external AI / import - resolve/auto-create)
	if req.FolderID != nil {
		// Frontend optimization: use provided folder_id directly
		folderID = req.FolderID
	} else if req.FolderPath != nil {
		// External AI / Import: resolve folder path, creating folders if needed
		resolvedFolder, err := s.pathResolver.ResolveFolderPath(ctx, req.ProjectID, *req.FolderPath)
		if err != nil {
			return nil, err
		}
		folderID = resolvedFolder
	} else {
		// Should never reach here due to validation, but defensive check
		return nil, fmt.Errorf("%w: either folder_path or folder_id must be provided", domain.ErrValidation)
	}

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
func (s *documentService) UpdateDocument(ctx context.Context, id string, req *services.UpdateDocumentRequest) (*models.Document, error) {
	// Get existing document
	doc, err := s.docRepo.GetByID(ctx, id, req.ProjectID)
	if err != nil {
		return nil, err
	}

	// Update fields
	if req.Name != nil {
		doc.Name = *req.Name
	}

	// Priority-based folder resolution for moving documents:
	// 1. Try folder_id first (frontend optimization - direct lookup)
	// 2. Fall back to folder_path (external AI - resolve/auto-create)
	// 3. Neither = don't move document
	if req.FolderID != nil {
		// Frontend optimization: use provided folder_id directly
		doc.FolderID = req.FolderID
	} else if req.FolderPath != nil {
		// External AI: resolve folder path, creating folders if needed
		resolvedFolder, err := s.pathResolver.ResolveFolderPath(ctx, req.ProjectID, *req.FolderPath)
		if err != nil {
			return nil, err
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

// validateCreateRequest validates a document creation request
func (s *documentService) validateCreateRequest(req *services.CreateDocumentRequest) error {
	// Require at least one of FolderPath or FolderID
	if req.FolderPath == nil && req.FolderID == nil {
		return fmt.Errorf("either folder_path or folder_id must be provided")
	}

	// Validate folder path if provided
	if req.FolderPath != nil {
		if err := s.pathResolver.ValidateFolderPath(*req.FolderPath); err != nil {
			return err
		}
	}

	return validation.ValidateStruct(req,
		validation.Field(&req.ProjectID, validation.Required),
		validation.Field(&req.FolderPath,
			validation.Length(0, config.MaxDocumentPathLength), // 0-length allowed for root level
		),
		validation.Field(&req.Name,
			validation.Required,
			validation.Length(1, config.MaxDocumentNameLength),
		),
		validation.Field(&req.Content, validation.Required),
	)
}

