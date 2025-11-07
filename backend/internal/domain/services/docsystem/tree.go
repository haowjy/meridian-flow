package docsystem

import (
	"context"

	"meridian/internal/domain/models/docsystem"
)

// TreeService defines operations for building document trees
type TreeService interface {
	// GetProjectTree builds and returns the nested folder/document tree for a project
	GetProjectTree(ctx context.Context, projectID string) (*docsystem.TreeNode, error)
}
