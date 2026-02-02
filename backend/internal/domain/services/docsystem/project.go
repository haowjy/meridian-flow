package docsystem

import (
	"context"

	"meridian/internal/domain/models/docsystem"
	"meridian/internal/optional"
)

// CreateProjectRequest represents a request to create a project
type CreateProjectRequest struct {
	UserID string `json:"user_id"`
	Name   string `json:"name"`
}

// UpdateProjectRequest represents a request to update a project.
// All fields are optional - only provided fields are updated.
// SystemPrompt uses tri-state: absent=don't change, null=clear, value=set.
type UpdateProjectRequest struct {
	Name         *string
	SystemPrompt optional.Optional[string]
	Preferences  docsystem.JSONMap // If provided, replaces preferences (nil = don't change)
}

// ProjectService defines business logic operations for projects
type ProjectService interface {
	// CreateProject creates a new project
	CreateProject(ctx context.Context, req *CreateProjectRequest) (*docsystem.Project, error)

	// GetProject retrieves a project by ID
	GetProject(ctx context.Context, id, userID string) (*docsystem.Project, error)

	// ListProjects retrieves all projects for a user
	ListProjects(ctx context.Context, userID string) ([]docsystem.Project, error)

	// UpdateProject updates a project's name
	UpdateProject(ctx context.Context, id, userID string, req *UpdateProjectRequest) (*docsystem.Project, error)

	// DeleteProject soft-deletes a project by setting deleted_at timestamp
	// Returns the deleted project with deleted_at set
	DeleteProject(ctx context.Context, id, userID string) (*docsystem.Project, error)
}
