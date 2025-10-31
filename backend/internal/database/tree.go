package database

import (
	"fmt"

	"github.com/jimmyyao/meridian/backend/internal/models"
)

// BuildTree builds a nested tree structure for all folders and documents in a project
func (db *DB) BuildTree(projectID string) (*models.TreeNode, error) {
	// Get all folders in the project
	allFolders, err := db.getAllFolders(projectID)
	if err != nil {
		return nil, err
	}

	// Get all documents in the project
	allDocuments, err := db.getAllDocumentsMetadata(projectID)
	if err != nil {
		return nil, err
	}

	// Build folder hierarchy
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

	// Second pass: nest folders
	for _, folder := range allFolders {
		node := folderMap[folder.ID]
		if folder.ParentID == nil {
			// Root level folder - just track ID
			rootFolderIDs = append(rootFolderIDs, folder.ID)
		} else {
			// Add to parent (as pointer reference)
			if parent, exists := folderMap[*folder.ParentID]; exists {
				parent.Folders = append(parent.Folders, node)
			}
		}
	}

	// Third pass: add documents to their folders
	var rootDocuments []models.DocumentTreeNode
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
	var rootFolders []*models.FolderTreeNode
	for _, folderID := range rootFolderIDs {
		if node, exists := folderMap[folderID]; exists {
			rootFolders = append(rootFolders, node)
		}
	}

	tree := &models.TreeNode{
		Folders:   rootFolders,
		Documents: rootDocuments,
	}

	return tree, nil
}

// getAllFolders retrieves all folders in a project (flat list)
func (db *DB) getAllFolders(projectID string) ([]models.Folder, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, parent_id, name, created_at
		FROM %s
		WHERE project_id = $1
		ORDER BY created_at ASC
	`, db.Tables.Folders)

	rows, err := db.Query(query, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to get all folders: %w", err)
	}
	defer rows.Close()

	var folders []models.Folder
	for rows.Next() {
		var folder models.Folder
		err := rows.Scan(
			&folder.ID,
			&folder.ProjectID,
			&folder.ParentID,
			&folder.Name,
			&folder.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan folder: %w", err)
		}
		folders = append(folders, folder)
	}

	return folders, nil
}

// getAllDocumentsMetadata retrieves all documents in a project (metadata only, no content)
func (db *DB) getAllDocumentsMetadata(projectID string) ([]models.Document, error) {
	query := fmt.Sprintf(`
		SELECT id, project_id, folder_id, name, word_count, updated_at
		FROM %s
		WHERE project_id = $1
		ORDER BY updated_at DESC
	`, db.Tables.Documents)

	rows, err := db.Query(query, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to get all documents metadata: %w", err)
	}
	defer rows.Close()

	var documents []models.Document
	for rows.Next() {
		var doc models.Document
		err := rows.Scan(
			&doc.ID,
			&doc.ProjectID,
			&doc.FolderID,
			&doc.Name,
			&doc.WordCount,
			&doc.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan document: %w", err)
		}
		documents = append(documents, doc)
	}

	return documents, nil
}

