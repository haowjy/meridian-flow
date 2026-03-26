package llm

import (
	"context"
)

// ThreadService defines the business logic for thread CRUD operations
// This service handles only thread session management (create, read, update, delete)
// For thread history and navigation, see ThreadHistoryService
// For turn creation and streaming, see StreamingService
type ThreadService interface {
	// CreateThread creates a new thread session
	// Validates project exists and user has access
	CreateThread(ctx context.Context, req *CreateThreadRequest) (*Thread, error)

	// GetThread retrieves a thread by ID
	// Validates user has access to the thread's project
	GetThread(ctx context.Context, threadID, userID string) (*Thread, error)

	// ListThreads retrieves all threads for a project
	// Validates user has access to the project
	ListThreads(ctx context.Context, projectID, userID string) ([]Thread, error)

	// UpdateThread updates a thread's title
	// Validates user has access
	UpdateThread(ctx context.Context, threadID, userID string, req *UpdateThreadRequest) (*Thread, error)

	// UpdateLastViewedTurn updates the last_viewed_turn_id field for a thread
	// Validates user has access to the thread
	UpdateLastViewedTurn(ctx context.Context, threadID, userID string, turnID *string) error

	// DeleteThread soft-deletes a thread and returns the deleted thread object
	// Validates user has access
	DeleteThread(ctx context.Context, threadID, userID string) (*Thread, error)

	// ListChildThreads retrieves all child threads spawned from a parent thread.
	// Validates the caller has access to the parent thread before returning children.
	// Returns an empty slice (not an error) if the parent has no children.
	ListChildThreads(ctx context.Context, parentThreadID, userID string) ([]Thread, error)
}

// CreateThreadRequest is the DTO for creating a new thread
type CreateThreadRequest struct {
	ProjectID string  `json:"project_id"`
	UserID    string  `json:"user_id"`
	Title     string  `json:"title"`
	// WorkItemID optionally associates the new thread with an existing work item.
	// When nil, the thread service will auto-provision an ephemeral work item.
	WorkItemID *string `json:"work_item_id,omitempty"`
}

// UpdateThreadRequest is the DTO for updating a thread
type UpdateThreadRequest struct {
	Title string `json:"title"`
}
