package llm

import (
	"time"
)

// Thread represents a conversation thread within a project
type Thread struct {
	ID               string     `json:"id" db:"id"`
	ProjectID        string     `json:"project_id" db:"project_id"`
	UserID           string     `json:"user_id" db:"user_id"`
	Title            string     `json:"title" db:"title"`
	SystemPrompt     *string    `json:"system_prompt,omitempty" db:"system_prompt"`
	LastViewedTurnID *string    `json:"last_viewed_turn_id" db:"last_viewed_turn_id"`
	// WorkItemID links the thread to a work item. Null for threads that have not
	// yet been associated with a work item (legacy or newly created before
	// ephemeral provisioning runs).
	WorkItemID       *string    `json:"work_item_id,omitempty" db:"work_item_id"`
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

// ThreadTree contains the lightweight tree structure of a thread for cache validation
// Frontend uses this to detect gaps, new branches, and structural changes
type ThreadTree struct {
	Turns     []TurnTreeNode `json:"turns"`
	UpdatedAt time.Time      `json:"updated_at"`
}
