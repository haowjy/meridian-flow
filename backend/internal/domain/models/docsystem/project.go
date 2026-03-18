package docsystem

import (
	"time"
)

// JSONMap is a type alias for JSONB columns (consistent with user_preferences)
type JSONMap = map[string]interface{}

type Project struct {
	ID             string     `json:"id" db:"id"`
	UserID         string     `json:"user_id" db:"user_id"`
	Name           string     `json:"name" db:"name"`
	Slug           string     `json:"slug" db:"slug"` // URL-friendly identifier, unique per user
	SystemPrompt   *string    `json:"system_prompt,omitempty" db:"system_prompt"`
	Preferences    JSONMap    `json:"preferences,omitempty" db:"preferences"` // JSONB project settings - uses map like other JSONB cols
	IsFavorite     bool       `json:"is_favorite" db:"-"`                     // Computed from junction table, not stored on project
	LastActivityAt time.Time  `json:"last_activity_at" db:"last_activity_at"`
	CreatedAt      time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at" db:"updated_at"`
	DeletedAt      *time.Time `json:"deleted_at,omitempty" db:"deleted_at"`
}
