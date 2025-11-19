package docsystem

import (
	"context"
	"fmt"
	"strings"
	"unicode"

	"meridian/internal/config"
	"meridian/internal/domain/repositories"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
)

type pathResolverService struct {
	folderRepo docsysRepo.FolderRepository
	txManager  repositories.TransactionManager
}

// NewPathResolver creates a new path resolver service
func NewPathResolver(
	folderRepo docsysRepo.FolderRepository,
	txManager repositories.TransactionManager,
) docsysSvc.PathResolver {
	return &pathResolverService{
		folderRepo: folderRepo,
		txManager:  txManager,
	}
}

// ResolveFolderPath resolves a folder path to a folder ID, creating folders if needed
func (s *pathResolverService) ResolveFolderPath(ctx context.Context, projectID, folderPath string) (*string, error) {
	// Trim leading/trailing slashes
	folderPath = strings.Trim(folderPath, "/")

	// Empty path means root level
	if folderPath == "" {
		return nil, nil
	}

	// Split path into folder segments
	segments := strings.Split(folderPath, "/")
	if len(segments) == 0 {
		return nil, fmt.Errorf("invalid folder_path")
	}

	// Create all folders in the hierarchy within a transaction
	var resultFolderID *string
	err := s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		var currentParentID *string

		for _, segment := range segments {
			// Validate folder name
			if len(segment) > config.MaxFolderNameLength {
				return fmt.Errorf("folder name '%s' exceeds maximum length of %d", segment, config.MaxFolderNameLength)
			}

			// Create folder if it doesn't exist
			folder, err := s.folderRepo.CreateIfNotExists(txCtx, projectID, currentParentID, segment)
			if err != nil {
				return fmt.Errorf("failed to create/get folder '%s': %w", segment, err)
			}

			// Move to next level
			currentParentID = &folder.ID
		}

		resultFolderID = currentParentID
		return nil
	})

	if err != nil {
		return nil, err
	}

	return resultFolderID, nil
}

// ValidateFolderPath validates a folder path
func (s *pathResolverService) ValidateFolderPath(path string) error {
	// Empty string is valid (root level)
	if path == "" {
		return nil
	}

	// Check length
	if len(path) > config.MaxDocumentPathLength {
		return fmt.Errorf("folder_path exceeds maximum length of %d", config.MaxDocumentPathLength)
	}

	// No leading/trailing slashes
	if strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") {
		return fmt.Errorf("folder_path cannot start or end with '/'")
	}

	// No consecutive slashes
	if strings.Contains(path, "//") {
		return fmt.Errorf("folder_path cannot contain consecutive slashes")
	}

	// Only alphanumeric, spaces, hyphens, underscores, dots, slashes
	for _, char := range path {
		if !unicode.IsLetter(char) && !unicode.IsDigit(char) &&
			char != ' ' && char != '-' && char != '_' && char != '.' && char != '/' {
			return fmt.Errorf("folder_path contains invalid character: %c", char)
		}
	}

	// Prevent . and .. as complete folder names (path traversal safety)
	segments := strings.Split(path, "/")
	for _, segment := range segments {
		if segment == "." || segment == ".." {
			return fmt.Errorf("folder_path cannot contain '.' or '..' as folder names")
		}
	}

	return nil
}

// ResolvePathNotation handles Unix-style path notation with priority-based folder resolution
func (s *pathResolverService) ResolvePathNotation(ctx context.Context, req *docsysSvc.PathNotationRequest) (*docsysSvc.PathNotationResult, error) {
	// Check if name contains path notation
	if !IsPathNotation(req.Name) {
		// No path notation - just validate simple name and return
		name := strings.TrimSpace(req.Name)
		if err := ValidateSimpleName(name, req.MaxNameLength); err != nil {
			return nil, fmt.Errorf("invalid name: %w", err)
		}

		// Resolve folder using priority system (no path notation case)
		var resolvedFolderID *string
		if req.FolderID != nil {
			// Priority 1: Use provided folder_id directly
			resolvedFolderID = req.FolderID
		} else if req.FolderPath != nil {
			// Priority 2: Resolve folder_path
			resolved, err := s.ResolveFolderPath(ctx, req.ProjectID, *req.FolderPath)
			if err != nil {
				return nil, fmt.Errorf("failed to resolve folder_path: %w", err)
			}
			resolvedFolderID = resolved
		} else {
			// Priority 3: Use root (nil)
			resolvedFolderID = nil
		}

		return &docsysSvc.PathNotationResult{
			ResolvedFolderID: resolvedFolderID,
			FinalName:        name,
		}, nil
	}

	// Path notation detected - parse it
	pathResult, err := ParsePath(req.Name, req.MaxNameLength)
	if err != nil {
		return nil, fmt.Errorf("invalid path notation: %w", err)
	}

	// Resolve base folder ID based on absolute vs relative
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
			resolved, err := s.ResolveFolderPath(ctx, req.ProjectID, *req.FolderPath)
			if err != nil {
				return nil, fmt.Errorf("failed to resolve folder_path for relative path notation: %w", err)
			}
			baseParentID = resolved
		} else {
			// Priority 3: Use root (nil)
			baseParentID = nil
		}
	}

	// Create intermediate folders and resolve final folder ID in a transaction
	var resolvedFolderID *string
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

			// Move to next level
			currentParentID = &intermediateFolder.ID
		}

		// Store resolved folder ID
		resolvedFolderID = currentParentID
		return nil
	})

	if err != nil {
		return nil, err
	}

	// Validate final name (no slashes allowed)
	if err := ValidateSimpleName(pathResult.FinalName, req.MaxNameLength); err != nil {
		return nil, fmt.Errorf("invalid final name '%s': %w", pathResult.FinalName, err)
	}

	return &docsysSvc.PathNotationResult{
		ResolvedFolderID: resolvedFolderID,
		FinalName:        pathResult.FinalName,
	}, nil
}
