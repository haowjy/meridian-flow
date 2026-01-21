package docsystem

import (
	"context"
)

// FavoriteService defines business logic operations for user project favorites
type FavoriteService interface {
	// AddFavorite marks a project as favorite for a user
	// Returns error if project doesn't exist or user doesn't own it
	AddFavorite(ctx context.Context, userID, projectID string) error

	// RemoveFavorite unmarks a project as favorite for a user
	// Returns error if project doesn't exist or user doesn't own it
	RemoveFavorite(ctx context.Context, userID, projectID string) error
}
