package services

import (
	"context"

	"meridian/internal/domain/models"
)

// CreateProjectRequest represents a request to create a project
type CreateProjectRequest struct {
	UserID string `json:"user_id"`
	Name   string `json:"name"`
}

// UpdateProjectRequest represents a request to update a project
type UpdateProjectRequest struct {
	Name string `json:"name"`
}

// ProjectService defines business logic operations for projects
type ProjectService interface {
	// CreateProject creates a new project
	CreateProject(ctx context.Context, req *CreateProjectRequest) (*models.Project, error)

	// GetProject retrieves a project by ID
	GetProject(ctx context.Context, id, userID string) (*models.Project, error)

	// ListProjects retrieves all projects for a user
	ListProjects(ctx context.Context, userID string) ([]models.Project, error)

	// UpdateProject updates a project's name
	UpdateProject(ctx context.Context, id, userID string, req *UpdateProjectRequest) (*models.Project, error)

	// DeleteProject deletes a project
	// Returns clear error if project has documents
	DeleteProject(ctx context.Context, id, userID string) error
}
