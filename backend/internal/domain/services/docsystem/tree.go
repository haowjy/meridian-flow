package docsystem

import (
	"context"
)

// TreeService defines operations for building document trees
type TreeService interface {
	// GetProjectTree builds and returns the nested folder/document tree for a project
	// userID is used for authorization check
	GetProjectTree(ctx context.Context, userID, projectID string) (*ProjectTree, error)
}
