package docsystem

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"meridian/internal/config"
	"meridian/internal/domain"
	models "meridian/internal/domain/models/docsystem"
	"meridian/internal/domain/repositories"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"

	validation "github.com/go-ozzo/ozzo-validation/v4"
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

	var folderID *string
	var docName string

	// Check if name contains path notation
	if IsPathNotation(req.Name) {
		// Parse path notation in name field
		pathResult, err := ParsePath(req.Name, config.MaxDocumentNameLength)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid path notation in name: %v", domain.ErrValidation, err)
		}

		s.logger.Debug("path notation detected in name",
			"original_name", req.Name,
			"is_absolute", pathResult.IsAbsolute,
			"segments", pathResult.Segments,
			"final_name", pathResult.FinalName,
		)

		// Resolve base folder ID for relative paths
		var baseParentID *string
		if pathResult.IsAbsolute {
			// Absolute path: ignore both folder_id and folder_path, start from root
			baseParentID = nil
		} else {
			// Relative path: use priority system (folder_id → folder_path → root)
			if req.FolderID != nil {
				// Priority 1: Use provided folder_id directly
				baseParentID = req.FolderID
			} else if req.FolderPath != nil {
				// Priority 2: Resolve folder_path
				resolvedFolder, err := s.pathResolver.ResolveFolderPath(ctx, req.ProjectID, *req.FolderPath)
				if err != nil {
					return nil, fmt.Errorf("failed to resolve folder_path for relative path notation: %w", err)
				}
				baseParentID = resolvedFolder
			} else {
				// Priority 3: Use root (nil)
				baseParentID = nil
			}
		}

		// Create intermediate folders and resolve final folder ID in a transaction
		err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
			currentParentID := baseParentID

			// Create all intermediate folders (parent path)
			for _, segment := range pathResult.ParentPath {
				// Validate segment as folder name
				if err := ValidateSimpleName(segment, config.MaxFolderNameLength); err != nil {
					return fmt.Errorf("invalid folder name '%s': %w", segment, err)
				}

				// Create folder if it doesn't exist (idempotent)
				intermediateFolder, err := s.folderRepo.CreateIfNotExists(txCtx, req.ProjectID, currentParentID, segment)
				if err != nil {
					return fmt.Errorf("failed to create intermediate folder '%s': %w", segment, err)
				}

				s.logger.Debug("intermediate folder created/found",
					"name", segment,
					"id", intermediateFolder.ID,
				)

				// Move to next level
				currentParentID = &intermediateFolder.ID
			}

			// Store resolved folder ID
			folderID = currentParentID
			return nil
		})

		if err != nil {
			return nil, err
		}

		// Use final segment as document name
		docName = pathResult.FinalName

		// Validate final document name (no slashes allowed)
		if err := ValidateSimpleName(docName, config.MaxDocumentNameLength); err != nil {
			return nil, fmt.Errorf("%w: invalid final document name '%s': %v", domain.ErrValidation, docName, err)
		}

	} else {
		// No path notation in name - use standard validation and folder resolution

		// Validate request (simple name validation)
		if err := s.validateCreateRequest(req); err != nil {
			return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
		}

		docName = strings.TrimSpace(req.Name)

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

// validateCreateRequest validates a document creation request
func (s *documentService) validateCreateRequest(req *docsysSvc.CreateDocumentRequest) error {
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
			validation.Match(regexp.MustCompile(`^[^/]+$`)).Error("document name cannot contain slashes"),
		),
		validation.Field(&req.Content, validation.Required),
	)
}
