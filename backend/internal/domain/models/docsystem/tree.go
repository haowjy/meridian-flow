package docsystem

import "time"

// TreeNode represents the root of the document tree
type TreeNode struct {
	Folders   []*FolderTreeNode  `json:"folders"`
	Documents []DocumentTreeNode `json:"documents"`
}

// FolderTreeNode represents a folder in the tree with nested children
type FolderTreeNode struct {
	ID        string             `json:"id"`
	Name      string             `json:"name"`
	ParentID  *string            `json:"folder_id"`
	CreatedAt time.Time          `json:"created_at"`
	Folders   []*FolderTreeNode  `json:"folders"` // Pointers for proper nesting
	Documents []DocumentTreeNode `json:"documents"`
}

// DocumentTreeNode represents a document in the tree (metadata only, no content)
type DocumentTreeNode struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	FolderID  *string   `json:"folder_id"`
	WordCount int       `json:"word_count"`
	UpdatedAt time.Time `json:"updated_at"`
}
