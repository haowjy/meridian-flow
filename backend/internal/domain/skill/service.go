package skill

import (
	"context"
)

// CreateSkillRequest contains the parameters for creating a skill
type CreateSkillRequest struct {
	ProjectID              string
	Name                   string
	Description            string
	Content                string // Skill content (stored in DB)
	DisableModelInvocation bool
	UserInvocable          bool
}

// UpdateSkillRequest contains the parameters for updating a skill
type UpdateSkillRequest struct {
	Name                   *string
	Description            *string
	Content                *string // Skill content (stored in DB)
	DisableModelInvocation *bool
	UserInvocable          *bool
}

// ProjectSkillService defines business logic operations for project skills
type ProjectSkillService interface {
	// CreateSkill creates a new skill with its folder structure
	// Content is stored in DB, folder exists for references/export
	CreateSkill(ctx context.Context, userID string, req CreateSkillRequest) (*ProjectSkill, error)

	// ListSkills lists all skills for a project
	ListSkills(ctx context.Context, userID, projectID string) ([]*ProjectSkill, error)

	// GetSkill retrieves a skill by ID (content included in model)
	GetSkill(ctx context.Context, userID, projectID, skillID string) (*ProjectSkill, error)

	// UpdateSkill updates a skill's metadata and/or content
	UpdateSkill(ctx context.Context, userID, projectID, skillID string, req UpdateSkillRequest) (*ProjectSkill, error)

	// ReorderSkills updates the positions of skills
	ReorderSkills(ctx context.Context, userID, projectID string, skillIDs []string) error

	// DeleteSkill soft-deletes a skill
	DeleteSkill(ctx context.Context, userID, projectID, skillID string) error
}
