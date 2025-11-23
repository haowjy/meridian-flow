package docsystem

import (
	"context"
	"log/slog"

	models "meridian/internal/domain/models/docsystem"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
)

// treeService implements the TreeService interface
type treeService struct {
	folderRepo   docsysRepo.FolderRepository
	documentRepo docsysRepo.DocumentRepository
	logger       *slog.Logger
}

// NewTreeService creates a new tree service
func NewTreeService(
	folderRepo docsysRepo.FolderRepository,
	documentRepo docsysRepo.DocumentRepository,
	logger *slog.Logger,
) docsysSvc.TreeService {
	return &treeService{
		folderRepo:   folderRepo,
		documentRepo: documentRepo,
		logger:       logger,
	}
}

// GetProjectTree builds and returns the nested folder/document tree for a project
func (s *treeService) GetProjectTree(ctx context.Context, projectID string) (*models.TreeNode, error) {
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
	folderMap := make(map[string]*models.FolderTreeNode)
	var rootFolderIDs []string

	// First pass: create all folder nodes
	for _, folder := range allFolders {
		folderMap[folder.ID] = &models.FolderTreeNode{
			ID:        folder.ID,
			Name:      folder.Name,
			ParentID:  folder.ParentID,
			CreatedAt: folder.CreatedAt,
			Folders:   []*models.FolderTreeNode{},
			Documents: []models.DocumentTreeNode{},
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
	rootDocuments := make([]models.DocumentTreeNode, 0)
	for _, doc := range allDocuments {
		docNode := models.DocumentTreeNode{
			ID:        doc.ID,
			Name:      doc.Name,
			FolderID:  doc.FolderID,
			WordCount: doc.WordCount,
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
	rootFolders := make([]*models.FolderTreeNode, 0)
	for _, folderID := range rootFolderIDs {
		if node, exists := folderMap[folderID]; exists {
			rootFolders = append(rootFolders, node)
		}
	}

	tree := &models.TreeNode{
		Folders:   rootFolders,
		Documents: rootDocuments,
	}

	s.logger.Info("project tree built",
		"project_id", projectID,
		"folder_count", len(allFolders),
		"document_count", len(allDocuments),
	)

	return tree, nil
}
