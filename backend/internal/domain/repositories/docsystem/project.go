package docsystem

import (
	"context"

	"meridian/internal/domain/models/docsystem"
)

// ProjectRepository defines data access operations for projects
type ProjectRepository interface {
	// Create creates a new project and returns it with generated ID and timestamps
	Create(ctx context.Context, project *docsystem.Project) error

	// GetByID retrieves a project by ID
	GetByID(ctx context.Context, id, userID string) (*docsystem.Project, error)

	// List retrieves all projects for a user, ordered by updated_at DESC
	List(ctx context.Context, userID string) ([]docsystem.Project, error)

	// Update updates a project's name and updated_at timestamp
	Update(ctx context.Context, project *docsystem.Project) error

	// Delete soft-deletes a project by setting deleted_at timestamp
	// Returns the deleted project with deleted_at set
	Delete(ctx context.Context, id, userID string) (*docsystem.Project, error)
}
