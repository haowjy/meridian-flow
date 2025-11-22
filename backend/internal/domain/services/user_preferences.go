package services

import (
	"context"

	"github.com/google/uuid"
	"meridian/internal/domain/models"
)

// UserPreferencesService defines the business logic for user preferences operations
type UserPreferencesService interface {
	// GetPreferences retrieves preferences for a user
	// Returns default/empty preferences if none exist yet
	GetPreferences(ctx context.Context, userID uuid.UUID) (*models.UserPreferences, error)

	// UpdatePreferences updates user preferences (partial or full update)
	// Creates new preferences if they don't exist
	UpdatePreferences(ctx context.Context, userID uuid.UUID, req *models.UpdatePreferencesRequest) (*models.UserPreferences, error)
}
