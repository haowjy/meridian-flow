package docsystem

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"strings"

	models "meridian/internal/domain/models/docsystem"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
)

var (
	// ErrInvalidPath indicates a path failed validation
	ErrInvalidPath = errors.New("invalid path")

	// ErrPathTraversal indicates a path contains .. segments
	ErrPathTraversal = errors.New("path traversal not allowed")

	// multiSlashRegex matches multiple consecutive slashes
	multiSlashRegex = regexp.MustCompile(`/+`)
)

// namespaceService implements the NamespaceService interface
type namespaceService struct {
	folderRepo docsysRepo.FolderRepository
	logger     *slog.Logger
}

// NewNamespaceService creates a new namespace service
func NewNamespaceService(
	folderRepo docsysRepo.FolderRepository,
	logger *slog.Logger,
) docsysSvc.NamespaceService {
	return &namespaceService{
		folderRepo: folderRepo,
		logger:     logger,
	}
}

// NormalizePath applies canonicalization rules to a path
// Rules:
// - Trim leading/trailing whitespace
// - Remove leading /
// - Reject .. segments (path traversal)
// - Collapse multiple / to single /
// - Trim trailing /
// - Reject null bytes
func (s *namespaceService) NormalizePath(path string) (string, error) {
	// 1. Trim whitespace
	path = strings.TrimSpace(path)

	// 2. Reject null bytes
	if strings.Contains(path, "\x00") {
		return "", errors.New("path contains null bytes")
	}

	// 3. Remove leading /
	path = strings.TrimPrefix(path, "/")

	// 4. Reject .. segments (must check before collapsing slashes)
	segments := strings.Split(path, "/")
	for _, seg := range segments {
		if seg == ".." {
			return "", ErrPathTraversal
		}
	}

	// 5. Collapse multiple / to single /
	path = multiSlashRegex.ReplaceAllString(path, "/")

	// 6. Trim trailing /
	path = strings.TrimSuffix(path, "/")

	// 7. Empty path is valid (represents root)
	return path, nil
}

// ParsePath extracts namespace and relative path from a normalized path
// Only matches namespace at root level (foo/.meridian/bar is NOT in .meridian namespace)
func (s *namespaceService) ParsePath(path string) (docsysSvc.Namespace, string, error) {
	// Normalize first
	normalized, err := s.NormalizePath(path)
	if err != nil {
		return "", "", err
	}

	// Root-only namespace detection
	if normalized == string(docsysSvc.NamespaceMeridian) {
		return docsysSvc.NamespaceMeridian, "", nil
	}
	if strings.HasPrefix(normalized, string(docsysSvc.NamespaceMeridian)+"/") {
		relPath := strings.TrimPrefix(normalized, string(docsysSvc.NamespaceMeridian)+"/")
		return docsysSvc.NamespaceMeridian, relPath, nil
	}

	if normalized == string(docsysSvc.NamespaceSession) {
		return docsysSvc.NamespaceSession, "", nil
	}
	if strings.HasPrefix(normalized, string(docsysSvc.NamespaceSession)+"/") {
		relPath := strings.TrimPrefix(normalized, string(docsysSvc.NamespaceSession)+"/")
		return docsysSvc.NamespaceSession, relPath, nil
	}

	if normalized == string(docsysSvc.NamespaceAgents) {
		return docsysSvc.NamespaceAgents, "", nil
	}
	if strings.HasPrefix(normalized, string(docsysSvc.NamespaceAgents)+"/") {
		relPath := strings.TrimPrefix(normalized, string(docsysSvc.NamespaceAgents)+"/")
		return docsysSvc.NamespaceAgents, relPath, nil
	}

	// Default space namespace
	return docsysSvc.NamespaceWorkspace, normalized, nil
}

// EnsureMeridianFolder creates /.meridian/ folder if it doesn't exist.
// Deprecated: keep until skills migrate off /.meridian.
func (s *namespaceService) EnsureMeridianFolder(ctx context.Context, projectID string) (*models.Folder, error) {
	folder, err := s.folderRepo.CreateSystemIfNotExists(ctx, projectID, string(docsysSvc.NamespaceMeridian), nil)
	if err != nil {
		return nil, err
	}

	s.logger.Debug("ensured .meridian folder",
		"project_id", projectID,
		"folder_id", folder.ID,
	)

	return folder, nil
}

// EnsureMeridianSubfolder creates /.meridian/<name>/ subfolder if it doesn't exist.
// Deprecated: keep until skills migrate off /.meridian.
func (s *namespaceService) EnsureMeridianSubfolder(ctx context.Context, projectID, name string) (*models.Folder, error) {
	// First ensure parent .meridian folder exists
	meridianFolder, err := s.EnsureMeridianFolder(ctx, projectID)
	if err != nil {
		return nil, err
	}

	// Create subfolder as hidden
	subfolder, err := s.folderRepo.CreateHiddenIfNotExists(ctx, projectID, &meridianFolder.ID, name)
	if err != nil {
		return nil, err
	}

	s.logger.Debug("ensured .meridian subfolder",
		"project_id", projectID,
		"name", name,
		"folder_id", subfolder.ID,
	)

	return subfolder, nil
}
