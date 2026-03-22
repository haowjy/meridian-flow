package docsystem

import (
	"context"
)

// TreeOptions controls tree building behavior
type TreeOptions struct {
	IncludeHidden bool // Default false: exclude is_hidden=true and is_system=true folders
}

// TreeService defines operations for building document trees
type TreeService interface {
	// GetProjectTree builds and returns the nested folder/document tree for a project
	// userID is used for authorization check
	GetProjectTree(ctx context.Context, userID, projectID string) (*ProjectTree, error)

	// GetProjectTreeWithOptions builds tree with options (e.g., include hidden folders)
	GetProjectTreeWithOptions(ctx context.Context, userID, projectID string, opts TreeOptions) (*ProjectTree, error)
}
