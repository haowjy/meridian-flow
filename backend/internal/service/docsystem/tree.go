package docsystem

import (
	"context"
	"log/slog"

	models "meridian/internal/domain/models/docsystem"
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

// GetProjectTree builds and returns the nested folder/document tree for a project.
// Default: excludes hidden/system folders. Use GetProjectTreeWithOptions for control.
func (s *treeService) GetProjectTree(ctx context.Context, userID, projectID string) (*docsysSvc.ProjectTree, error) {
	return s.GetProjectTreeWithOptions(ctx, userID, projectID, docsysSvc.TreeOptions{
		IncludeHidden: false, // Default: exclude hidden/system folders
	})
}

// GetProjectTreeWithOptions builds tree with explicit options
func (s *treeService) GetProjectTreeWithOptions(ctx context.Context, userID, projectID string, opts docsysSvc.TreeOptions) (*docsysSvc.ProjectTree, error) {
	// Authorize: check user can access this project
	if err := s.authorizer.CanAccessProject(ctx, userID, projectID); err != nil {
		return nil, err
	}

	// Get folders with filtering
	allFolders, err := s.folderRepo.GetAllByProjectFiltered(ctx, projectID, docsysRepo.FolderFilterOptions{
		IncludeHidden: opts.IncludeHidden,
	})
	if err != nil {
		return nil, err
	}

	// Get all documents in the project (metadata only, no content)
	allDocuments, err := s.documentRepo.GetAllMetadataByProject(ctx, projectID)
	if err != nil {
		return nil, err
	}

	// Build folder hierarchy using 4-pass algorithm (added path computation)
	folderMap := make(map[string]*docsysSvc.TreeFolder)
	folderModelMap := make(map[string]*models.Folder) // For path computation
	var rootFolderIDs []string

	// First pass: create all folder nodes and index models
	for i := range allFolders {
		folder := &allFolders[i]
		folderModelMap[folder.ID] = folder
		folderMap[folder.ID] = &docsysSvc.TreeFolder{
			ID:          folder.ID,
			ProjectID:   folder.ProjectID,
			FolderID:    folder.ParentID,
			Name:        folder.Name,
			IsHidden:    folder.IsHidden,
			IsSystem:    folder.IsSystem,
			Description: folder.Description,
			Autoapply:   folder.Autoapply,
			Metadata:    folder.Metadata,
			CreatedAt:   folder.CreatedAt,
			UpdatedAt:   folder.UpdatedAt,
			Folders:     []*docsysSvc.TreeFolder{},
			Documents:   []docsysSvc.TreeDocument{},
		}
	}

	// Second pass: compute folder paths (bottom-up traversal)
	for id, node := range folderMap {
		node.Path = s.computeFolderPath(id, folderModelMap)
	}

	// Third pass: nest folders by connecting children to parents
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

	// Build hidden folder set to filter documents in hidden folders
	hiddenFolderIDs := make(map[string]bool)
	if !opts.IncludeHidden {
		// Since we filtered folders already, we need to get the full list to know
		// which folders are hidden for document filtering
		allFoldersUnfiltered, err := s.folderRepo.GetAllByProject(ctx, projectID)
		if err != nil {
			return nil, err
		}
		for _, folder := range allFoldersUnfiltered {
			if s.isFilteredFolder(folder) || s.isInFilteredFolder(folder.ID, allFoldersUnfiltered) {
				hiddenFolderIDs[folder.ID] = true
			}
		}
	}

	// Fourth pass: add documents to their folders
	rootDocuments := make([]docsysSvc.TreeDocument, 0)
	for _, doc := range allDocuments {
		// Skip documents in hidden folders when not including hidden
		if !opts.IncludeHidden && doc.FolderID != nil && hiddenFolderIDs[*doc.FolderID] {
			continue
		}

		// Compute document path
		var docPath string
		if doc.FolderID == nil {
			// Root level document
			docPath = doc.Name + doc.Extension
		} else if folder, exists := folderMap[*doc.FolderID]; exists {
			docPath = folder.Path + "/" + doc.Name + doc.Extension
		} else {
			// Folder not in tree (filtered out), skip document
			continue
		}

		docNode := docsysSvc.TreeDocument{
			ID:                   doc.ID,
			ProjectID:            doc.ProjectID,
			Name:                 doc.Name,
			FolderID:             doc.FolderID,
			Extension:            doc.Extension,
			FileType:             doc.FileType,
			Description:          doc.Description,
			PendingProposalCount: doc.PendingProposalCount,
			Path:                 docPath,
			UpdatedAt:            doc.UpdatedAt,
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

// computeFolderPath builds path by walking up parent chain
func (s *treeService) computeFolderPath(folderID string, folderMap map[string]*models.Folder) string {
	var segments []string
	currentID := folderID

	for {
		folder, exists := folderMap[currentID]
		if !exists {
			break
		}
		segments = append([]string{folder.Name}, segments...)
		if folder.ParentID == nil {
			break
		}
		currentID = *folder.ParentID
	}

	// Join without leading slash (normalized path)
	path := ""
	for i, seg := range segments {
		if i > 0 {
			path += "/"
		}
		path += seg
	}
	return path
}

func (s *treeService) isFilteredFolder(folder models.Folder) bool {
	return folder.IsHidden || folder.IsSystem
}

// isInFilteredFolder checks if a folder is inside a hidden/system parent folder.
func (s *treeService) isInFilteredFolder(folderID string, allFolders []models.Folder) bool {
	folderMap := make(map[string]*models.Folder)
	for i := range allFolders {
		folderMap[allFolders[i].ID] = &allFolders[i]
	}

	currentID := folderID
	for {
		folder, exists := folderMap[currentID]
		if !exists {
			break
		}
		if s.isFilteredFolder(*folder) {
			return true
		}
		if folder.ParentID == nil {
			break
		}
		currentID = *folder.ParentID
	}
	return false
}
