package handler

import (
	"time"

	skill "meridian/internal/domain/skill"
)

// === Request DTOs ===

// CreateSkillRequest is the request body for creating a skill
type CreateSkillRequest struct {
	Name                   string `json:"name"`
	Description            string `json:"description"`
	Content                string `json:"content,omitempty"` // SKILL.md content
	DisableModelInvocation *bool  `json:"disable_model_invocation,omitempty"`
	UserInvocable          *bool  `json:"user_invocable,omitempty"`
}

// UpdateSkillRequest is the request body for updating a skill
type UpdateSkillRequest struct {
	Name                   *string `json:"name,omitempty"`
	Description            *string `json:"description,omitempty"`
	Content                *string `json:"content,omitempty"` // SKILL.md content
	Enabled                *bool   `json:"enabled,omitempty"` // Enable/disable skill
	DisableModelInvocation *bool   `json:"disable_model_invocation,omitempty"`
	UserInvocable          *bool   `json:"user_invocable,omitempty"`
}

// ReorderSkillsRequest is the request body for reordering skills
type ReorderSkillsRequest struct {
	SkillIDs []string `json:"skill_ids"`
}

// === Response DTOs ===

// SkillResponse is the response for a single skill (metadata only)
// API shape remains flat - backend extracts fields from JSONB metadata
type SkillResponse struct {
	ID                     string    `json:"id"`
	ProjectID              string    `json:"project_id"`
	Name                   string    `json:"name"`
	Description            string    `json:"description"`
	Position               int       `json:"position"`
	Enabled                bool      `json:"enabled"` // Whether skill is active
	DisableModelInvocation bool      `json:"disable_model_invocation"`
	UserInvocable          bool      `json:"user_invocable"`
	SyncState              string    `json:"sync_state"`
	IsDirty                bool      `json:"is_dirty"`
	CreatedAt              time.Time `json:"created_at"`
	UpdatedAt              time.Time `json:"updated_at"`
}

// SkillWithContentResponse is the response for a skill with content
type SkillWithContentResponse struct {
	SkillResponse
	Content string `json:"content"`
}

// SkillListResponse is the response for listing skills
type SkillListResponse struct {
	Skills []SkillResponse `json:"skills"`
	Count  int             `json:"count"`
}

// === DTO Conversion ===

// toSkillResponse converts a ProjectSkill model to a response DTO
// Extracts metadata from JSONB and flattens for API response
func toSkillResponse(skill *skill.ProjectSkill) SkillResponse {
	meta := skill.GetMetadata()
	return SkillResponse{
		ID:                     skill.ID,
		ProjectID:              skill.ProjectID,
		Name:                   skill.Name,
		Description:            skill.Description,
		Position:               skill.Position,
		Enabled:                skill.Enabled,
		DisableModelInvocation: meta.DisableModelInvocation,
		UserInvocable:          meta.UserInvocable,
		SyncState:              string(skill.SyncState),
		IsDirty:                skill.IsDirty,
		CreatedAt:              skill.CreatedAt,
		UpdatedAt:              skill.UpdatedAt,
	}
}

// toSkillWithContentResponse converts a ProjectSkill model to a response DTO with content
func toSkillWithContentResponse(skill *skill.ProjectSkill) SkillWithContentResponse {
	return SkillWithContentResponse{
		SkillResponse: toSkillResponse(skill),
		Content:       skill.Content,
	}
}

// toSkillListResponse converts a list of ProjectSkill models to a response DTO
func toSkillListResponse(skills []*skill.ProjectSkill) SkillListResponse {
	responses := make([]SkillResponse, len(skills))
	for i, skill := range skills {
		responses[i] = toSkillResponse(skill)
	}
	return SkillListResponse{
		Skills: responses,
		Count:  len(responses),
	}
}
