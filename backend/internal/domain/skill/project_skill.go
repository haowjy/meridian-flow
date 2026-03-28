package skill

import (
	"encoding/json"
	"time"
)

// SyncState represents the synchronization state with a template
type SyncState string

const (
	// SyncStateDetached means the skill is not linked to any template
	SyncStateDetached SyncState = "detached"
	// SyncStateSynced means the skill is in sync with its template
	SyncStateSynced SyncState = "synced"
	// SyncStateOutdated means the template has newer changes
	SyncStateOutdated SyncState = "outdated"
	// SyncStateModified means the skill has local changes not in template
	SyncStateModified SyncState = "modified"
)

// JSONMap is a type alias for JSONB columns (same as models.JSONMap)
type JSONMap map[string]interface{}

// SkillMetadata is the typed struct for skill settings stored in metadata JSONB
type SkillMetadata struct {
	DisableModelInvocation bool `json:"disableModelInvocation"`
	UserInvocable          bool `json:"userInvocable"`
}

// DefaultSkillMetadata returns the default metadata for a new skill
func DefaultSkillMetadata() SkillMetadata {
	return SkillMetadata{
		DisableModelInvocation: false,
		UserInvocable:          true,
	}
}

// ProjectSkill represents a skill installed in a project.
// Content is sourced from .agents/skills/<slug>/SKILL.md. The folder
// (/.meridian/skills/<name>/) remains for reference documents.
type ProjectSkill struct {
	ID               string  `json:"id" db:"id"`
	ProjectID        string  `json:"project_id" db:"project_id"`
	InstanceFolderID string  `json:"instance_folder_id" db:"instance_folder_id"`
	Name             string  `json:"name" db:"name"`               // Skill identifier (e.g., "writing-coach")
	Description      string  `json:"description" db:"description"` // Short description for context
	Content          string  `json:"content" db:"content"`         // Skill instructions from SKILL.md
	Position         int     `json:"position" db:"position"`       // Order in skill list
	Enabled          bool    `json:"enabled" db:"enabled"`         // Whether skill is active (default true)
	Metadata         JSONMap `json:"metadata" db:"metadata"`       // JSONB for settings (disableModelInvocation, userInvocable, etc.)
	// Template linking (future)
	SourceTemplateVersionID *string    `json:"source_template_version_id,omitempty" db:"source_template_version_id"`
	SyncState               SyncState  `json:"sync_state" db:"sync_state"`
	IsDirty                 bool       `json:"is_dirty" db:"is_dirty"`
	LastSyncedAt            *time.Time `json:"last_synced_at,omitempty" db:"last_synced_at"`
	// Timestamps
	CreatedAt time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt time.Time  `json:"updated_at" db:"updated_at"`
	DeletedAt *time.Time `json:"deleted_at,omitempty" db:"deleted_at"`
}

// GetMetadata extracts typed metadata from JSONMap
// Returns default values if metadata is nil or missing fields
func (s *ProjectSkill) GetMetadata() SkillMetadata {
	if s.Metadata == nil {
		return DefaultSkillMetadata()
	}

	// Marshal/unmarshal for type safety (same pattern as user_preferences.go)
	data, err := json.Marshal(s.Metadata)
	if err != nil {
		return DefaultSkillMetadata()
	}

	var meta SkillMetadata
	if err := json.Unmarshal(data, &meta); err != nil {
		return DefaultSkillMetadata()
	}

	return meta
}

// SetMetadata stores typed metadata into JSONMap
func (s *ProjectSkill) SetMetadata(meta SkillMetadata) {
	data, err := json.Marshal(meta)
	if err != nil {
		s.Metadata = JSONMap{}
		return
	}

	var m JSONMap
	if err := json.Unmarshal(data, &m); err != nil {
		s.Metadata = JSONMap{}
		return
	}

	s.Metadata = m
}
