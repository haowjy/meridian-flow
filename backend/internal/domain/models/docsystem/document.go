package docsystem

import (
	"time"
)

type Document struct {
	ID        string     `json:"id" db:"id"`
	ProjectID string     `json:"project_id" db:"project_id"`
	FolderID  *string    `json:"folder_id" db:"folder_id"` // NULL = root level
	Name      string     `json:"name" db:"name"`           // Just "Aria", not "Characters/Aria"
	Path      string     `json:"path,omitempty"`           // Computed display path, not stored in DB
	Content   string     `json:"content" db:"content"`               // Markdown content
	AIVersion    *string `json:"ai_version,omitempty" db:"ai_version"`       // AI's suggested version (nullable)
	AIVersionRev int     `json:"ai_version_rev" db:"ai_version_rev"`         // Revision counter for CAS
	WordCount    int     `json:"word_count" db:"word_count"`
	CreatedAt time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt time.Time  `json:"updated_at" db:"updated_at"`
	DeletedAt *time.Time `json:"deleted_at,omitempty" db:"deleted_at"`
}
