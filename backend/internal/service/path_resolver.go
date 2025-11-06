package service

import (
	"context"
	"fmt"
	"strings"
	"unicode"

	"meridian/internal/config"
	"meridian/internal/domain/repositories"
	"meridian/internal/domain/services"
)

type pathResolverService struct {
	folderRepo repositories.FolderRepository
	txManager  repositories.TransactionManager
}

// NewPathResolver creates a new path resolver service
func NewPathResolver(
	folderRepo repositories.FolderRepository,
	txManager repositories.TransactionManager,
) services.PathResolver {
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

	// Only alphanumeric, spaces, hyphens, underscores, slashes
	for _, char := range path {
		if !unicode.IsLetter(char) && !unicode.IsDigit(char) &&
			char != ' ' && char != '-' && char != '_' && char != '/' {
			return fmt.Errorf("folder_path contains invalid character: %c", char)
		}
	}

	return nil
}
