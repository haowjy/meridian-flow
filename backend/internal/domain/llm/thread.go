package llm

import (
	"encoding/json"
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
	// Persona stores the persona slug used when this thread was created or
	// when a persona turn was first sent on it. Null for non-persona threads.
	Persona          *string    `json:"persona,omitempty" db:"persona"`
	// ParentThreadID links this thread to its parent when created via spawn_agent.
	// Null for top-level threads. FK to threads(id).
	ParentThreadID   *string    `json:"parent_thread_id,omitempty" db:"parent_thread_id"`
	// SpawnStatus tracks the lifecycle of a spawned child thread.
	// Null for non-spawn threads. Values: running, succeeded, failed, cancelled, timed_out.
	SpawnStatus      *SpawnStatus `json:"spawn_status,omitempty" db:"spawn_status"`
	// SpawnResultJSON stores the structured outcome of a completed spawn as JSONB.
	// Null while the spawn is running or for non-spawn threads.
	SpawnResultJSON  *json.RawMessage `json:"spawn_result,omitempty" db:"spawn_result"`
	// SpawnDepth is denormalized: child.SpawnDepth = parent.SpawnDepth + 1.
	// 0 for top-level threads. Used for O(1) depth limit checks without chain walking.
	SpawnDepth       int        `json:"spawn_depth" db:"spawn_depth"`
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
