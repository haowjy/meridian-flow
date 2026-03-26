package llm

import "context"

// SpawnStatus represents the lifecycle state of a spawned child thread.
type SpawnStatus string

const (
	SpawnStatusRunning   SpawnStatus = "running"
	SpawnStatusSucceeded SpawnStatus = "succeeded"
	SpawnStatusFailed    SpawnStatus = "failed"
	SpawnStatusCancelled SpawnStatus = "cancelled"
	SpawnStatusTimedOut  SpawnStatus = "timed_out"
)

// SpawnRequest contains parameters for creating a child agent thread.
type SpawnRequest struct {
	ProjectID      string // Project this spawn belongs to
	UserID         string // User who initiated the spawn
	ParentThreadID string // Thread that called spawn_agent
	WorkItemID     string // Inherited from parent thread
	AgentSlug      string // Persona slug for the child agent
	Prompt         string // Task description for the child agent
}

// SpawnResult contains the outcome of a completed spawn.
// Stored as JSONB in the child thread's spawn_result column.
type SpawnResult struct {
	ChildThreadID string                 `json:"child_thread_id"`
	Status        string                 `json:"status"`           // "succeeded" | "failed" | "timed_out" | "cancelled"
	Summary       string                 `json:"summary,omitempty"`
	Artifacts     []string               `json:"artifacts,omitempty"`
	Metadata      map[string]interface{} `json:"metadata,omitempty"`
}

// SpawnInvoker is a narrow interface that breaks the circular dependency between
// SpawnService (which needs to create child turns via StreamingService) and
// StreamingService (which needs to invoke spawns from the spawn_agent tool).
//
// StreamingService implements this interface, allowing the spawn_agent tool to
// call CreateSpawn without depending on the full SpawnService.
type SpawnInvoker interface {
	// CreateSpawn creates a child thread, starts streaming, and blocks until completion.
	// Returns the spawn result or an error (including timeout after 5 minutes).
	CreateSpawn(ctx context.Context, req *SpawnRequest) (*SpawnResult, error)

	// GetSpawnStatus retrieves the current status of a child thread spawn.
	GetSpawnStatus(ctx context.Context, parentThreadID, childThreadID string) (*SpawnResult, error)

	// CancelSpawn cancels an active child thread spawn.
	CancelSpawn(ctx context.Context, parentThreadID, childThreadID string) error
}
