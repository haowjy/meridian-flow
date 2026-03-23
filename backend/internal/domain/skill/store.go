package skill

import (
	"context"
)

// ProjectSkillStore defines data access operations for project skills
type ProjectSkillStore interface {
	// Create creates a new project skill
	Create(ctx context.Context, skill *ProjectSkill) error

	// GetByID retrieves a skill by ID with project scoping
	GetByID(ctx context.Context, id, projectID string) (*ProjectSkill, error)

	// GetByName retrieves a skill by name with project scoping
	GetByName(ctx context.Context, name, projectID string) (*ProjectSkill, error)

	// ListByProject lists all skills for a project (ordered by position)
	ListByProject(ctx context.Context, projectID string) ([]*ProjectSkill, error)

	// Update updates an existing skill
	Update(ctx context.Context, skill *ProjectSkill) error

	// UpdatePositions updates the positions of skills (for reordering)
	UpdatePositions(ctx context.Context, projectID string, skillIDs []string) error

	// Delete soft-deletes a skill
	Delete(ctx context.Context, id, projectID string) (*ProjectSkill, error)
}
