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
	SystemPrompt     *string    `json:"system_prompt,omitempty" db:"system_prompt"`
	LastViewedTurnID *string    `json:"last_viewed_turn_id,omitempty" db:"last_viewed_turn_id"`
	CreatedAt        time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at" db:"updated_at"`
	DeletedAt        *time.Time `json:"deleted_at,omitempty" db:"deleted_at"`
}

// PaginatedTurnsResponse contains paginated turns with metadata
// Turns include nested blocks and sibling_ids
type PaginatedTurnsResponse struct {
	Turns         []Turn `json:"turns"`
	HasMoreBefore bool   `json:"has_more_before"`
	HasMoreAfter  bool   `json:"has_more_after"`
}

// TurnTreeNode represents a lightweight turn node in the conversation tree
// Used for cache validation and detecting structural changes
type TurnTreeNode struct {
	ID         string  `json:"id"`
	PrevTurnID *string `json:"prev_turn_id"`
}

// ChatTree contains the lightweight tree structure of a chat for cache validation
// Frontend uses this to detect gaps, new branches, and structural changes
type ChatTree struct {
	Turns     []TurnTreeNode `json:"turns"`
	UpdatedAt time.Time      `json:"updated_at"`
}
