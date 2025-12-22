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
	"meridian/internal/domain/services"
	docsysSvc "meridian/internal/domain/services/docsystem"

	validation "github.com/go-ozzo/ozzo-validation/v4"
)

type folderService struct {
	folderRepo   docsysRepo.FolderRepository
	docRepo      docsysRepo.DocumentRepository
	docService   docsysSvc.DocumentService // For delegating document deletion (SRP)
	pathResolver docsysSvc.PathResolver
	txManager    repositories.TransactionManager
	validator    *ResourceValidator
	authorizer   services.ResourceAuthorizer
	logger       *slog.Logger
}

// NewFolderService creates a new folder service
func NewFolderService(
	folderRepo docsysRepo.FolderRepository,
	docRepo docsysRepo.DocumentRepository,
	docService docsysSvc.DocumentService, // For delegating document deletion (SRP)
	pathResolver docsysSvc.PathResolver,
	txManager repositories.TransactionManager,
	validator *ResourceValidator,
	authorizer services.ResourceAuthorizer,
	logger *slog.Logger,
) docsysSvc.FolderService {
	return &folderService{
		folderRepo:   folderRepo,
		docRepo:      docRepo,
		docService:   docService,
		pathResolver: pathResolver,
		txManager:    txManager,
		validator:    validator,
		authorizer:   authorizer,
		logger:       logger,
	}
}

// CreateFolder creates a new folder
// Supports Unix-style path notation:
//   - "name" → create folder with given name at folder_id
//   - "a/b/c" → auto-create intermediate folders (a, b) and final folder (c) at folder_id
//   - "/a/b/c" → absolute path from root (ignore folder_id)
func (s *folderService) CreateFolder(ctx context.Context, req *docsysSvc.CreateFolderRequest) (*models.Folder, error) {
	// Normalize empty string to nil for root-level folders
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
		MaxNameLength: config.MaxFolderNameLength,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Check for duplicate name in target folder
	siblingFolders, err := s.folderRepo.ListChildren(ctx, result.ResolvedFolderID, req.ProjectID)
	if err != nil {
		return nil, fmt.Errorf("failed to check for duplicate names: %w", err)
	}
	for _, sibling := range siblingFolders {
		if sibling.Name == result.FinalName {
			return nil, &domain.ConflictError{
				Message:      fmt.Sprintf("a folder named %q already exists in this location", result.FinalName),
				ResourceType: "folder",
				ResourceID:   sibling.ID,
			}
		}
	}

	// Create the final folder
	folder := &models.Folder{
		ProjectID: req.ProjectID,
		ParentID:  result.ResolvedFolderID,
		Name:      result.FinalName,
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
		"parent_folder_id", folder.ParentID,
		"path", folder.Path,
	)

	return folder, nil
}

// GetFolder retrieves a folder with its computed path
// Authorization is checked first via the injected authorizer
func (s *folderService) GetFolder(ctx context.Context, userID, folderID string) (*models.Folder, error) {
	// Authorize: check user can access this folder
	if err := s.authorizer.CanAccessFolder(ctx, userID, folderID); err != nil {
		return nil, err
	}

	// Get folder (authorization already done, use GetByIDOnly)
	folder, err := s.folderRepo.GetByIDOnly(ctx, folderID)
	if err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.folderRepo.GetPath(ctx, &folder.ID, folder.ProjectID)
	if err != nil {
		s.logger.Warn("failed to compute path", "folder_id", folder.ID, "error", err)
		folder.Path = folder.Name
	} else {
		folder.Path = path
	}

	return folder, nil
}

// UpdateFolder updates a folder (rename or move)
// Authorization is checked first via the injected authorizer
func (s *folderService) UpdateFolder(ctx context.Context, userID, folderID string, req *docsysSvc.UpdateFolderRequest) (*models.Folder, error) {
	// Authorize: check user can access this folder
	if err := s.authorizer.CanAccessFolder(ctx, userID, folderID); err != nil {
		return nil, err
	}

	// Validate request
	if err := s.validateUpdateRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Get existing folder (authorization already done, use GetByIDOnly)
	folder, err := s.folderRepo.GetByIDOnly(ctx, folderID)
	if err != nil {
		return nil, err
	}

	// Update fields
	if req.Name != nil {
		folder.Name = strings.TrimSpace(*req.Name)
	}

	// Tri-state: only update folder location if field was present in request
	if req.FolderID.Present {
		if req.FolderID.Value != nil {
			// Move to specified folder
			parent, err := s.folderRepo.GetByID(ctx, *req.FolderID.Value, folder.ProjectID)
			if err != nil {
				return nil, fmt.Errorf("parent folder not found: %w", err)
			}

			// Prevent circular references (can't move folder to be a child of itself or its descendants)
			if err := s.validateNoCircularReference(ctx, folderID, *req.FolderID.Value, folder.ProjectID); err != nil {
				return nil, err
			}

			folder.ParentID = &parent.ID
			s.logger.Debug("moving folder to new parent",
				"folder_id", folderID,
				"new_folder_id", parent.ID,
			)
		} else {
			// null = move to root
			folder.ParentID = nil
			s.logger.Debug("moving folder to root", "folder_id", folderID)
		}
	}

	// Check for duplicate name in target folder (if name or parent changed)
	if req.Name != nil || req.FolderID.Present {
		siblingFolders, err := s.folderRepo.ListChildren(ctx, folder.ParentID, folder.ProjectID)
		if err != nil {
			return nil, fmt.Errorf("failed to check for duplicate names: %w", err)
		}
		for _, sibling := range siblingFolders {
			if sibling.ID != folder.ID && sibling.Name == folder.Name {
				return nil, &domain.ConflictError{
					Message:      fmt.Sprintf("a folder named %q already exists in this location", folder.Name),
					ResourceType: "folder",
					ResourceID:   sibling.ID,
				}
			}
		}
	}

	folder.UpdatedAt = time.Now()

	// Update in database
	if err := s.folderRepo.Update(ctx, folder); err != nil {
		return nil, err
	}

	// Compute display path
	path, err := s.folderRepo.GetPath(ctx, &folder.ID, folder.ProjectID)
	if err != nil {
		s.logger.Warn("failed to compute path", "folder_id", folder.ID, "error", err)
		folder.Path = folder.Name
	} else {
		folder.Path = path
	}

	s.logger.Info("folder updated",
		"id", folder.ID,
		"name", folder.Name,
		"folder_id", folder.ParentID,
		"path", folder.Path,
	)

	return folder, nil
}

// DeleteFolder deletes a folder and all its contents (documents and subfolders) recursively.
// Authorization is checked first via the injected authorizer.
func (s *folderService) DeleteFolder(ctx context.Context, userID, folderID string) error {
	// Authorize: check user can access this folder
	if err := s.authorizer.CanAccessFolder(ctx, userID, folderID); err != nil {
		return err
	}

	// Get folder (authorization already done, use GetByIDOnly)
	folder, err := s.folderRepo.GetByIDOnly(ctx, folderID)
	if err != nil {
		return err
	}

	// Recursively delete all descendants (child folders and documents)
	if err := s.deleteDescendants(ctx, userID, folderID, folder.ProjectID); err != nil {
		return err
	}

	// Delete the folder itself
	if err := s.folderRepo.Delete(ctx, folderID, folder.ProjectID); err != nil {
		return err
	}

	s.logger.Info("folder deleted",
		"id", folderID,
		"name", folder.Name,
		"project_id", folder.ProjectID,
	)

	return nil
}

// deleteDescendants recursively deletes all child folders and documents.
// Documents are deleted via DocumentService to maintain SRP.
func (s *folderService) deleteDescendants(ctx context.Context, userID, folderID, projectID string) error {
	// 1. Get and recursively delete child folders
	childFolders, err := s.folderRepo.ListChildren(ctx, &folderID, projectID)
	if err != nil {
		return fmt.Errorf("failed to list child folders: %w", err)
	}

	for _, child := range childFolders {
		// Recursively delete this child's descendants first
		if err := s.deleteDescendants(ctx, userID, child.ID, projectID); err != nil {
			return err
		}
		// Then delete the child folder itself
		if err := s.folderRepo.Delete(ctx, child.ID, projectID); err != nil {
			return fmt.Errorf("failed to delete child folder %q: %w", child.Name, err)
		}
		s.logger.Debug("deleted child folder", "id", child.ID, "name", child.Name)
	}

	// 2. Delete all documents in this folder via DocumentService (SRP: delegate to owner)
	docs, err := s.docRepo.ListByFolder(ctx, &folderID, projectID)
	if err != nil {
		return fmt.Errorf("failed to list documents: %w", err)
	}

	for _, doc := range docs {
		if err := s.docService.DeleteDocument(ctx, userID, doc.ID); err != nil {
			return fmt.Errorf("failed to delete document %q: %w", doc.Name, err)
		}
		s.logger.Debug("deleted document", "id", doc.ID, "name", doc.Name)
	}

	return nil
}

// ListChildren lists all child folders and documents in a folder
// Authorization is checked first via the injected authorizer
func (s *folderService) ListChildren(ctx context.Context, userID string, folderID *string, projectID string) (*docsysSvc.FolderContents, error) {
	// Authorize: check user can access this project
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}
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

	return &docsysSvc.FolderContents{
		Folder:    folder,
		Folders:   childFolders,
		Documents: docs,
	}, nil
}

// validateCreateRequest validates a folder creation request
func (s *folderService) validateCreateRequest(req *docsysSvc.CreateFolderRequest) error {
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
func (s *folderService) validateUpdateRequest(req *docsysSvc.UpdateFolderRequest) error {
	// At least one field must be provided
	if req.Name == nil && !req.FolderID.Present {
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
