package docsystem

import (
	"context"
	"log/slog"

	docsysRepo "meridian/internal/domain/repositories/docsystem"
	"meridian/internal/domain/services"
	docsysSvc "meridian/internal/domain/services/docsystem"
)

// treeService implements the TreeService interface
type treeService struct {
	folderRepo   docsysRepo.FolderRepository
	documentRepo docsysRepo.DocumentRepository
	authorizer   services.ResourceAuthorizer
	logger       *slog.Logger
}

// NewTreeService creates a new tree service
func NewTreeService(
	folderRepo docsysRepo.FolderRepository,
	documentRepo docsysRepo.DocumentRepository,
	authorizer services.ResourceAuthorizer,
	logger *slog.Logger,
) docsysSvc.TreeService {
	return &treeService{
		folderRepo:   folderRepo,
		documentRepo: documentRepo,
		authorizer:   authorizer,
		logger:       logger,
	}
}

// GetProjectTree builds and returns the nested folder/document tree for a project
// Authorization is checked first via the injected authorizer
func (s *treeService) GetProjectTree(ctx context.Context, userID, projectID string) (*docsysSvc.ProjectTree, error) {
	// Authorize: check user can access this project
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	// Get all folders in the project
	allFolders, err := s.folderRepo.GetAllByProject(ctx, projectID)
	if err != nil {
		return nil, err
	}

	// Get all documents in the project (metadata only, no content)
	allDocuments, err := s.documentRepo.GetAllMetadataByProject(ctx, projectID)
	if err != nil {
		return nil, err
	}

	// Build folder hierarchy using 3-pass algorithm
	folderMap := make(map[string]*docsysSvc.TreeFolder)
	var rootFolderIDs []string

	// First pass: create all folder nodes
	for _, folder := range allFolders {
		folderMap[folder.ID] = &docsysSvc.TreeFolder{
			ID:        folder.ID,
			ProjectID: folder.ProjectID,
			FolderID:  folder.ParentID,
			Name:      folder.Name,
			CreatedAt: folder.CreatedAt,
			UpdatedAt: folder.UpdatedAt,
			Folders:   []*docsysSvc.TreeFolder{},
			Documents: []docsysSvc.TreeDocument{},
		}
	}

	// Second pass: nest folders by connecting children to parents
	for _, folder := range allFolders {
		node := folderMap[folder.ID]
		if folder.ParentID == nil {
			// Root level folder - track ID for final tree
			rootFolderIDs = append(rootFolderIDs, folder.ID)
		} else {
			// Add to parent (as pointer reference for proper nesting)
			if parent, exists := folderMap[*folder.ParentID]; exists {
				parent.Folders = append(parent.Folders, node)
			}
		}
	}

	// Third pass: add documents to their folders
	rootDocuments := make([]docsysSvc.TreeDocument, 0)
	for _, doc := range allDocuments {
		docNode := docsysSvc.TreeDocument{
			ID:        doc.ID,
			ProjectID: doc.ProjectID,
			Name:      doc.Name,
			Slug:      doc.Slug,
			FolderID:  doc.FolderID,
			Extension: doc.Extension,
			UpdatedAt: doc.UpdatedAt,
		}

		if doc.FolderID == nil {
			// Root level document
			rootDocuments = append(rootDocuments, docNode)
		} else {
			// Add to parent folder
			if parent, exists := folderMap[*doc.FolderID]; exists {
				parent.Documents = append(parent.Documents, docNode)
			}
		}
	}

	// Build final tree using root folder pointers
	rootFolders := make([]*docsysSvc.TreeFolder, 0)
	for _, folderID := range rootFolderIDs {
		if node, exists := folderMap[folderID]; exists {
			rootFolders = append(rootFolders, node)
		}
	}

	tree := &docsysSvc.ProjectTree{
		Folders:   rootFolders,
		Documents: rootDocuments,
	}

	return tree, nil
}
