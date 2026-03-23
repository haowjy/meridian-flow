package llm

import (
	"context"
)

// ThreadStore defines the interface for thread data access
type ThreadStore interface {
	// CreateThread creates a new thread session
	CreateThread(ctx context.Context, thread *Thread) error

	// GetThread retrieves a thread by ID (scoped to user)
	// Returns domain.ErrNotFound if not found
	GetThread(ctx context.Context, threadID, userID string) (*Thread, error)

	// GetThreadByIDOnly retrieves a thread by UUID only (no user scoping)
	// Used by ResourceAuthorizer when authorization is handled separately
	// Returns domain.ErrNotFound if not found
	GetThreadByIDOnly(ctx context.Context, threadID string) (*Thread, error)

	// ListThreadsByProject retrieves all threads for a project
	// Returns empty slice if no threads found
	ListThreadsByProject(ctx context.Context, projectID, userID string) ([]Thread, error)

	// UpdateThread updates a thread's mutable fields (title, last_viewed_turn_id, updated_at)
	// Returns domain.ErrNotFound if not found
	UpdateThread(ctx context.Context, thread *Thread) error

	// UpdateLastViewedTurn updates only the last_viewed_turn_id field
	// Returns domain.ErrNotFound if thread not found
	UpdateLastViewedTurn(ctx context.Context, threadID, userID string, turnID *string) error

	// DeleteThread soft-deletes a thread and returns the deleted thread object
	// Returns domain.ErrNotFound if not found or already deleted
	DeleteThread(ctx context.Context, threadID, userID string) (*Thread, error)

	// GetThreadTree retrieves the lightweight tree structure of a thread for cache validation
	// Returns only turn IDs and parent relationships (no content)
	// Performance: <100ms even for 1000+ turns
	// Used by frontend to detect gaps, new branches, and structural changes
	GetThreadTree(ctx context.Context, threadID, userID string) (*ThreadTree, error)
}
