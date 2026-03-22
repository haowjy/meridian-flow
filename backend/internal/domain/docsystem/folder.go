package docsystem

import (
	"time"
)

type Folder struct {
	ID          string                 `json:"id" db:"id"`
	ProjectID   string                 `json:"project_id" db:"project_id"`
	ParentID    *string                `json:"folder_id" db:"parent_id"` // NULL = root level (JSON uses folder_id for API consistency)
	Name        string                 `json:"name" db:"name"`
	IsHidden    bool                   `json:"is_hidden" db:"is_hidden"` // Hidden folders excluded from tree by default (e.g., /.meridian/)
	IsSystem    bool                   `json:"is_system" db:"is_system"` // System folders are immutable and hidden from default tree views
	Description *string                `json:"description,omitempty" db:"description"`
	Autoapply   *bool                  `json:"autoapply,omitempty" db:"autoapply"`
	Metadata    map[string]interface{} `json:"metadata" db:"metadata"`
	Path        string                 `json:"path,omitempty"` // Computed display path, not stored in DB
	CreatedAt   time.Time              `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time              `json:"updated_at" db:"updated_at"`
	DeletedAt   *time.Time             `json:"deleted_at,omitempty" db:"deleted_at"`
}

func (f *Folder) EnsureMetadata() {
	if f.Metadata == nil {
		f.Metadata = map[string]interface{}{}
	}
}
