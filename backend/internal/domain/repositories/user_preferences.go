package repositories

import (
	"context"

	"github.com/google/uuid"
	"meridian/internal/domain/models"
)

// UserPreferencesRepository defines the interface for user preferences data access
type UserPreferencesRepository interface {
	// GetByUserID retrieves preferences for a specific user
	// Returns nil if no preferences exist (user hasn't set any yet)
	GetByUserID(ctx context.Context, userID uuid.UUID) (*models.UserPreferences, error)

	// Upsert creates or updates user preferences
	// If preferences don't exist, creates new row
	// If preferences exist, updates the row
	Upsert(ctx context.Context, prefs *models.UserPreferences) error
}
