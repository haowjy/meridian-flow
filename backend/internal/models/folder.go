package models

import (
	"time"
)

type Folder struct {
	ID        string    `json:"id" db:"id"`
	ProjectID string    `json:"project_id" db:"project_id"`
	ParentID  *string   `json:"parent_id" db:"parent_id"` // NULL = root level
	Name      string    `json:"name" db:"name"`
	Path      string    `json:"path,omitempty"`           // Computed display path, not stored in DB
	CreatedAt time.Time `json:"created_at" db:"created_at"`
	UpdatedAt time.Time `json:"updated_at" db:"updated_at"`
}

type CreateFolderRequest struct {
	ParentID *string `json:"parent_id,omitempty"`
	Name     string  `json:"name" validate:"required"`
}

type UpdateFolderRequest struct {
	ParentID *string `json:"parent_id,omitempty"`
	Name     *string `json:"name,omitempty"`
}

// TreeNode represents a node in the document tree
type TreeNode struct {
	Folders   []*FolderTreeNode  `json:"folders"`
	Documents []DocumentTreeNode `json:"documents"`
}

// FolderTreeNode represents a folder in the tree with nested children
type FolderTreeNode struct {
	ID        string             `json:"id"`
	Name      string             `json:"name"`
	ParentID  *string            `json:"parent_id"`
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
