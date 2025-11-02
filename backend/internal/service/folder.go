package service

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	validation "github.com/go-ozzo/ozzo-validation/v4"
	"meridian/internal/config"
	"meridian/internal/domain"
	"meridian/internal/domain/repositories"
	"meridian/internal/domain/services"
	"meridian/internal/domain/models"
)

type folderService struct {
	folderRepo repositories.FolderRepository
	docRepo    repositories.DocumentRepository
	logger     *slog.Logger
}

// NewFolderService creates a new folder service
func NewFolderService(
	folderRepo repositories.FolderRepository,
	docRepo repositories.DocumentRepository,
	logger *slog.Logger,
) services.FolderService {
	return &folderService{
		folderRepo: folderRepo,
		docRepo:    docRepo,
		logger:     logger,
	}
}

// CreateFolder creates a new folder
func (s *folderService) CreateFolder(ctx context.Context, req *services.CreateFolderRequest) (*models.Folder, error) {
	// Validate request
	if err := s.validateCreateRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Normalize empty string to nil for root-level folders (consistent with UPDATE)
	if req.ParentID != nil && *req.ParentID == "" {
		req.ParentID = nil
	}

	// If parent folder is specified, verify it exists
	if req.ParentID != nil {
		parent, err := s.folderRepo.GetByID(ctx, *req.ParentID, req.ProjectID)
		if err != nil {
			return nil, fmt.Errorf("parent folder not found: %w", err)
		}
		s.logger.Debug("parent folder found",
			"parent_id", parent.ID,
			"parent_name", parent.Name,
		)
	}

	// Create folder
	folder := &models.Folder{
		ProjectID: req.ProjectID,
		ParentID:  req.ParentID,
		Name:      req.Name,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	if err := s.folderRepo.Create(ctx, folder); err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.folderRepo.GetPath(ctx, &folder.ID, req.ProjectID)
	if err != nil {
		s.logger.Warn("failed to compute path", "folder_id", folder.ID, "error", err)
		folder.Path = folder.Name
	} else {
		folder.Path = path
	}

	s.logger.Info("folder created",
		"id", folder.ID,
		"name", folder.Name,
		"project_id", req.ProjectID,
		"parent_id", req.ParentID,
		"path", folder.Path,
	)

	return folder, nil
}

// GetFolder retrieves a folder with its computed path
func (s *folderService) GetFolder(ctx context.Context, id, projectID string) (*models.Folder, error) {
	folder, err := s.folderRepo.GetByID(ctx, id, projectID)
	if err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.folderRepo.GetPath(ctx, &folder.ID, projectID)
	if err != nil {
		s.logger.Warn("failed to compute path", "folder_id", folder.ID, "error", err)
		folder.Path = folder.Name
	} else {
		folder.Path = path
	}

	return folder, nil
}

// UpdateFolder updates a folder (rename or move)
func (s *folderService) UpdateFolder(ctx context.Context, id string, req *services.UpdateFolderRequest) (*models.Folder, error) {
	// Validate request
	if err := s.validateUpdateRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Get existing folder
	folder, err := s.folderRepo.GetByID(ctx, id, req.ProjectID)
	if err != nil {
		return nil, err
	}

	// Update fields
	if req.Name != nil {
		folder.Name = *req.Name
	}

	if req.ParentID != nil {
		// Validate parent folder exists (unless moving to root)
		if *req.ParentID != "" {
			parent, err := s.folderRepo.GetByID(ctx, *req.ParentID, req.ProjectID)
			if err != nil {
				return nil, fmt.Errorf("parent folder not found: %w", err)
			}

			// Prevent circular references (can't move folder to be a child of itself or its descendants)
			if err := s.validateNoCircularReference(ctx, id, *req.ParentID, req.ProjectID); err != nil {
				return nil, err
			}

			folder.ParentID = &parent.ID
			s.logger.Debug("moving folder to new parent",
				"folder_id", id,
				"new_parent_id", parent.ID,
			)
		} else {
			// Move to root
			folder.ParentID = nil
			s.logger.Debug("moving folder to root", "folder_id", id)
		}
	}

	folder.UpdatedAt = time.Now()

	// Update in database
	if err := s.folderRepo.Update(ctx, folder); err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.folderRepo.GetPath(ctx, &folder.ID, req.ProjectID)
	if err != nil {
		s.logger.Warn("failed to compute path", "folder_id", folder.ID, "error", err)
		folder.Path = folder.Name
	} else {
		folder.Path = path
	}

	s.logger.Info("folder updated",
		"id", folder.ID,
		"name", folder.Name,
		"parent_id", folder.ParentID,
		"path", folder.Path,
	)

	return folder, nil
}

// DeleteFolder deletes a folder (must be empty)
func (s *folderService) DeleteFolder(ctx context.Context, id, projectID string) error {
	// Verify folder exists
	folder, err := s.folderRepo.GetByID(ctx, id, projectID)
	if err != nil {
		return err
	}

	// Check for child folders
	childFolders, err := s.folderRepo.ListChildren(ctx, &id, projectID)
	if err != nil {
		return fmt.Errorf("failed to check child folders: %w", err)
	}
	if len(childFolders) > 0 {
		return fmt.Errorf("%w: folder contains %d subfolders", domain.ErrConflict, len(childFolders))
	}

	// Check for documents
	docs, err := s.docRepo.ListByFolder(ctx, &id, projectID)
	if err != nil {
		return fmt.Errorf("failed to check documents: %w", err)
	}
	if len(docs) > 0 {
		return fmt.Errorf("%w: folder contains %d documents", domain.ErrConflict, len(docs))
	}

	// Delete folder
	if err := s.folderRepo.Delete(ctx, id, projectID); err != nil {
		return err
	}

	s.logger.Info("folder deleted",
		"id", id,
		"name", folder.Name,
		"project_id", projectID,
	)

	return nil
}

// ListChildren lists all child folders and documents in a folder
func (s *folderService) ListChildren(ctx context.Context, folderID *string, projectID string) (*services.FolderContents, error) {
	var folder *models.Folder
	var err error

	// If folderID is provided, get the folder
	if folderID != nil && *folderID != "" {
		folder, err = s.folderRepo.GetByID(ctx, *folderID, projectID)
		if err != nil {
			return nil, err
		}

		// Compute display path
		path, err := s.folderRepo.GetPath(ctx, &folder.ID, projectID)
		if err != nil {
			s.logger.Warn("failed to compute path", "folder_id", folder.ID, "error", err)
			folder.Path = folder.Name
		} else {
			folder.Path = path
		}
	}

	// Get child folders
	childFolders, err := s.folderRepo.ListChildren(ctx, folderID, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list child folders: %w", err)
	}

	// Get documents in this folder
	docs, err := s.docRepo.ListByFolder(ctx, folderID, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list documents: %w", err)
	}

	// Compute paths for all documents
	for i := range docs {
		path, err := s.docRepo.GetPath(ctx, &docs[i])
		if err != nil {
			s.logger.Warn("failed to compute document path",
				"doc_id", docs[i].ID,
				"error", err,
			)
			docs[i].Path = docs[i].Name
		} else {
			docs[i].Path = path
		}
	}

	return &services.FolderContents{
		Folder:    folder,
		Folders:   childFolders,
		Documents: docs,
	}, nil
}

// validateCreateRequest validates a folder creation request
func (s *folderService) validateCreateRequest(req *services.CreateFolderRequest) error {
	return validation.ValidateStruct(req,
		validation.Field(&req.ProjectID, validation.Required),
		validation.Field(&req.Name,
			validation.Required,
			validation.Length(1, config.MaxFolderNameLength),
			validation.Match(regexp.MustCompile(`^[^/]+$`)).Error("folder name cannot contain slashes"),
		),
	)
}

// validateUpdateRequest validates a folder update request
func (s *folderService) validateUpdateRequest(req *services.UpdateFolderRequest) error {
	// At least one field must be provided
	if req.Name == nil && req.ParentID == nil {
		return fmt.Errorf("at least one field must be provided")
	}

	rules := []*validation.FieldRules{
		validation.Field(&req.ProjectID, validation.Required),
	}

	if req.Name != nil {
		rules = append(rules,
			validation.Field(&req.Name,
				validation.Required,
				validation.Length(1, config.MaxFolderNameLength),
				validation.Match(regexp.MustCompile(`^[^/]+$`)).Error("folder name cannot contain slashes"),
			),
		)
	}

	return validation.ValidateStruct(req, rules...)
}

// validateNoCircularReference ensures moving a folder won't create circular references
func (s *folderService) validateNoCircularReference(ctx context.Context, folderID, newParentID, projectID string) error {
	// Can't move folder to be its own parent
	if folderID == newParentID {
		return fmt.Errorf("%w: cannot move folder to be its own parent", domain.ErrValidation)
	}

	// Check if newParentID is a descendant of folderID
	currentID := newParentID
	for {
		parent, err := s.folderRepo.GetByID(ctx, currentID, projectID)
		if err != nil {
			return err
		}

		if parent.ParentID == nil {
			// Reached root, no circular reference
			break
		}

		if *parent.ParentID == folderID {
			return fmt.Errorf("%w: cannot move folder to be a child of its own descendant", domain.ErrValidation)
		}

		currentID = *parent.ParentID
	}

	return nil
}
