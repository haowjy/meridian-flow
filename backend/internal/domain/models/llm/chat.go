package llm

import (
	"time"
)

type Chat struct {
	ID        string         `json:"id" db:"id"`
	Name      string         `json:"name" db:"name"`
	CreatedAt time.Time      `json:"created_at" db:"created_at"`
	UpdatedAt time.Time      `json:"updated_at" db:"updated_at"`
	Messages  []*MessageNode `json:"messages"` // Pointers for proper nesting
}

// FolderTreeNode represents a folder in the tree with nested children
type MessageNode struct {
	ID       string         `json:"id"`
	ParentID *string        `json:"parent_id"`
	Messages []*MessageNode `json:"messages"` // Pointers for proper nesting
}
