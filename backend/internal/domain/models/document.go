package models

import (
	"time"
)

type Document struct {
	ID        string     `json:"id" db:"id"`
	ProjectID string     `json:"project_id" db:"project_id"`
	FolderID  *string    `json:"folder_id" db:"folder_id"` // NULL = root level
	Name      string     `json:"name" db:"name"`           // Just "Aria", not "Characters/Aria"
	Path      string     `json:"path,omitempty"`           // Computed display path, not stored in DB
	Content   string     `json:"content" db:"content"`     // Markdown content
	WordCount int        `json:"word_count" db:"word_count"`
	CreatedAt time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt time.Time  `json:"updated_at" db:"updated_at"`
}

type CreateDocumentRequest struct {
	// Path-based creation (auto-resolve folders)
	Path *string `json:"path,omitempty"`

	// Direct folder assignment
	FolderID *string `json:"folder_id,omitempty"`
	Name     *string `json:"name,omitempty"`

	Content string `json:"content" validate:"required"`
}

type UpdateDocumentRequest struct {
	Name     *string `json:"name,omitempty"`
	FolderID *string `json:"folder_id,omitempty"` // Move document
	Content  *string `json:"content,omitempty"`
}
