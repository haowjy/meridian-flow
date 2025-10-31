package models

import (
	"time"
)

type Document struct {
	ID              string                 `json:"id" db:"id"`
	ProjectID       string                 `json:"project_id" db:"project_id"`
	FolderID        *string                `json:"folder_id" db:"folder_id"` // NULL = root level
	Name            string                 `json:"name" db:"name"`           // Just "Aria", not "Characters/Aria"
	Path            string                 `json:"path,omitempty"`           // Computed display path, not stored in DB
	ContentTipTap   map[string]interface{} `json:"content_tiptap" db:"content_tiptap"`
	ContentMarkdown string                 `json:"content_markdown" db:"content_markdown"`
	WordCount       int                    `json:"word_count" db:"word_count"`
	CreatedAt       time.Time              `json:"created_at" db:"created_at"`
	UpdatedAt       time.Time              `json:"updated_at" db:"updated_at"`
}

type CreateDocumentRequest struct {
	// Path-based creation (auto-resolve folders)
	Path *string `json:"path,omitempty"`

	// Direct folder assignment
	FolderID *string `json:"folder_id,omitempty"`
	Name     *string `json:"name,omitempty"`

	ContentTipTap map[string]interface{} `json:"content_tiptap" validate:"required"`
}

type UpdateDocumentRequest struct {
	Name          *string                 `json:"name,omitempty"`
	FolderID      *string                 `json:"folder_id,omitempty"` // Move document
	ContentTipTap *map[string]interface{} `json:"content_tiptap,omitempty"`
}
