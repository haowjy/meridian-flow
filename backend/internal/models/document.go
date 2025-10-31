package models

import (
	"time"
)

type Document struct {
	ID              string                 `json:"id" db:"id"`
	ProjectID       string                 `json:"project_id" db:"project_id"`
	Path            string                 `json:"path" db:"path"`
	ContentTipTap   map[string]interface{} `json:"content_tiptap" db:"content_tiptap"`
	ContentMarkdown string                 `json:"content_markdown" db:"content_markdown"`
	WordCount       int                    `json:"word_count" db:"word_count"`
	CreatedAt       time.Time              `json:"created_at" db:"created_at"`
	UpdatedAt       time.Time              `json:"updated_at" db:"updated_at"`
}

type CreateDocumentRequest struct {
	Path          string                 `json:"path" validate:"required"`
	ContentTipTap map[string]interface{} `json:"content_tiptap" validate:"required"`
}

type UpdateDocumentRequest struct {
	Path          *string                 `json:"path,omitempty"`
	ContentTipTap *map[string]interface{} `json:"content_tiptap,omitempty"`
}

type DocumentListResponse struct {
	Documents []Document `json:"documents"`
	Total     int        `json:"total"`
}
