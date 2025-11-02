package repositories

import (
	"context"

	"meridian/internal/domain/models"
)

// ProjectRepository defines data access operations for projects
type ProjectRepository interface {
	// Create creates a new project and returns it with generated ID and timestamps
	Create(ctx context.Context, project *models.Project) error

	// GetByID retrieves a project by ID
	GetByID(ctx context.Context, id, userID string) (*models.Project, error)

	// List retrieves all projects for a user, ordered by updated_at DESC
	List(ctx context.Context, userID string) ([]models.Project, error)

	// Update updates a project's name and updated_at timestamp
	Update(ctx context.Context, project *models.Project) error

	// Delete deletes a project
	// Returns error if project has documents (FK constraint)
	Delete(ctx context.Context, id, userID string) error
}
