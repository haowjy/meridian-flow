package skill

import (
	"context"

	models "meridian/internal/domain/models/skill"
)

// CreateSkillRequest contains the parameters for creating a skill
type CreateSkillRequest struct {
	ProjectID              string
	Name                   string
	DisplayName            string
	Description            string
	Content                string // SKILL.md content
	DisableModelInvocation bool
	UserInvocable          bool
}

// UpdateSkillRequest contains the parameters for updating a skill
type UpdateSkillRequest struct {
	DisplayName            *string
	Description            *string
	Content                *string // SKILL.md content
	DisableModelInvocation *bool
	UserInvocable          *bool
}

// ProjectSkillService defines business logic operations for project skills
type ProjectSkillService interface {
	// CreateSkill creates a new skill with its folder structure and SKILL.md
	CreateSkill(ctx context.Context, userID string, req CreateSkillRequest) (*models.ProjectSkill, error)

	// ListSkills lists all skills for a project (metadata only)
	ListSkills(ctx context.Context, userID, projectID string) ([]*models.ProjectSkill, error)

	// GetSkill retrieves a skill by ID with content
	GetSkill(ctx context.Context, userID, projectID, skillID string) (*models.ProjectSkillWithContent, error)

	// GetSkillByName retrieves a skill by name with content
	GetSkillByName(ctx context.Context, userID, projectID, name string) (*models.ProjectSkillWithContent, error)

	// UpdateSkill updates a skill's metadata and/or content
	UpdateSkill(ctx context.Context, userID, projectID, skillID string, req UpdateSkillRequest) (*models.ProjectSkill, error)

	// ReorderSkills updates the positions of skills
	ReorderSkills(ctx context.Context, userID, projectID string, skillIDs []string) error

	// DeleteSkill soft-deletes a skill
	DeleteSkill(ctx context.Context, userID, projectID, skillID string) error

	// LoadSkillContent loads the content of a skill's SKILL.md file
	LoadSkillContent(ctx context.Context, userID, projectID, name string) (string, error)
}
