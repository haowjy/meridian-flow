package docsystem

import (
	"context"
)

// FavoriteStore defines data access operations for user project favorites
type FavoriteStore interface {
	// Add marks a project as favorite for a user
	// Returns nil if already favorited (idempotent)
	Add(ctx context.Context, userID, projectID string) error

	// Remove unmarks a project as favorite for a user
	// Returns nil if not favorited (idempotent)
	Remove(ctx context.Context, userID, projectID string) error
}
