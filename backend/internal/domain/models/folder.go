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
