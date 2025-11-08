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

type folderService struct {
	folderRepo   docsysRepo.FolderRepository
	docRepo      docsysRepo.DocumentRepository
	pathResolver docsysSvc.PathResolver
	txManager    repositories.TransactionManager
	logger       *slog.Logger
}

// NewFolderService creates a new folder service
func NewFolderService(
	folderRepo docsysRepo.FolderRepository,
	docRepo docsysRepo.DocumentRepository,
	pathResolver docsysSvc.PathResolver,
	txManager repositories.TransactionManager,
	logger *slog.Logger,
) docsysSvc.FolderService {
	return &folderService{
		folderRepo:   folderRepo,
		docRepo:      docRepo,
		pathResolver: pathResolver,
		txManager:    txManager,
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

	// Check if name contains path notation
	if IsPathNotation(req.Name) {
		// Parse path notation
		pathResult, err := ParsePath(req.Name, config.MaxFolderNameLength)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid path notation: %v", domain.ErrValidation, err)
		}

		s.logger.Debug("path notation detected",
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

		// Create intermediate folders and final folder in a single transaction
		var folder *models.Folder
		err = s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
			// Create all intermediate folders (parent path)
			currentParentID := baseParentID
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

			// Validate final name
			if err := ValidateSimpleName(pathResult.FinalName, config.MaxFolderNameLength); err != nil {
				return fmt.Errorf("invalid final folder name '%s': %w", pathResult.FinalName, err)
			}

			// Create final folder
			folder = &models.Folder{
				ProjectID: req.ProjectID,
				ParentID:  currentParentID,
				Name:      pathResult.FinalName,
				CreatedAt: time.Now(),
				UpdatedAt: time.Now(),
			}

			if err := s.folderRepo.Create(txCtx, folder); err != nil {
				return err
			}

			return nil
		})

		if err != nil {
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

		s.logger.Info("folder created via path notation",
			"id", folder.ID,
			"name", folder.Name,
			"original_path", req.Name,
			"project_id", req.ProjectID,
			"folder_id", folder.ParentID,
			"path", folder.Path,
		)

		return folder, nil
	}

	// No path notation - use original logic
	// Validate request (simple name validation)
	if err := s.validateCreateRequest(req); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrValidation, err)
	}

	// Resolve parent folder ID using priority system
	var folderID *string
	if req.FolderID != nil {
		// Priority 1: Use provided folder_id directly
		folderID = req.FolderID
	} else if req.FolderPath != nil {
		// Priority 2: Resolve folder_path
		resolvedFolder, err := s.pathResolver.ResolveFolderPath(ctx, req.ProjectID, *req.FolderPath)
		if err != nil {
			return nil, fmt.Errorf("failed to resolve folder_path: %w", err)
		}
		folderID = resolvedFolder
	} else {
		// Priority 3: Use root (nil)
		folderID = nil
	}

	// If parent folder is specified, verify it exists
	if folderID != nil {
		parent, err := s.folderRepo.GetByID(ctx, *folderID, req.ProjectID)
		if err != nil {
			return nil, fmt.Errorf("parent folder not found: %w", err)
		}
		s.logger.Debug("parent folder found",
			"folder_id", parent.ID,
			"parent_name", parent.Name,
		)
	}

	// Normalize name (trim whitespace)
	name := strings.TrimSpace(req.Name)

	// Create folder
	folder := &models.Folder{
		ProjectID: req.ProjectID,
		ParentID:  folderID,
		Name:      name,
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
		"folder_id", folderID,
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
func (s *folderService) UpdateFolder(ctx context.Context, id string, req *docsysSvc.UpdateFolderRequest) (*models.Folder, error) {
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
		folder.Name = strings.TrimSpace(*req.Name)
	}

	if req.FolderID != nil {
		// Validate parent folder exists (unless moving to root)
		if *req.FolderID != "" {
			parent, err := s.folderRepo.GetByID(ctx, *req.FolderID, req.ProjectID)
			if err != nil {
				return nil, fmt.Errorf("parent folder not found: %w", err)
			}

			// Prevent circular references (can't move folder to be a child of itself or its descendants)
			if err := s.validateNoCircularReference(ctx, id, *req.FolderID, req.ProjectID); err != nil {
				return nil, err
			}

			folder.ParentID = &parent.ID
			s.logger.Debug("moving folder to new parent",
				"folder_id", id,
				"new_folder_id", parent.ID,
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
		"folder_id", folder.ParentID,
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
func (s *folderService) ListChildren(ctx context.Context, folderID *string, projectID string) (*docsysSvc.FolderContents, error) {
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
	if req.Name == nil && req.FolderID == nil {
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
