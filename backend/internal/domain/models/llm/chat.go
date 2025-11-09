package llm

import (
	"time"
)

// Chat represents a chat session within a project
type Chat struct {
	ID               string     `json:"id" db:"id"`
	ProjectID        string     `json:"project_id" db:"project_id"`
	UserID           string     `json:"user_id" db:"user_id"`
	Title            string     `json:"title" db:"title"`
	LastViewedTurnID *string    `json:"last_viewed_turn_id,omitempty" db:"last_viewed_turn_id"`
	CreatedAt        time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at" db:"updated_at"`
	DeletedAt        *time.Time `json:"deleted_at,omitempty" db:"deleted_at"`
}
