package services

import (
	"context"

	"github.com/jimmyyao/meridian/backend/internal/domain/models"
)

// TreeService defines operations for building document trees
type TreeService interface {
	// GetProjectTree builds and returns the nested folder/document tree for a project
	GetProjectTree(ctx context.Context, projectID string) (*models.TreeNode, error)
}
