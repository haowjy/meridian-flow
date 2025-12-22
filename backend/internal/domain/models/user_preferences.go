package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// ProviderModel represents a provider/model pair for unambiguous model selection
type ProviderModel struct {
	Provider string `json:"provider"` // e.g., "anthropic", "openrouter"
	Model    string `json:"model"`    // e.g., "claude-haiku-4-5", "x-ai/grok-code-fast-1"
}

// JSONMap is a type alias for JSONB columns
type JSONMap map[string]interface{}

// UserPreferences represents user-specific settings and preferences
// All preferences are stored in a single JSONB column with namespaced structure
type UserPreferences struct {
	UserID      uuid.UUID `json:"user_id" db:"user_id"`
	Preferences JSONMap   `json:"preferences" db:"preferences"` // Namespaced JSONB: {models, ui, editor, system_instructions, notifications}
	CreatedAt   time.Time `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time `json:"updated_at" db:"updated_at"`
}

// ModelsPreferences represents the models namespace in preferences
type ModelsPreferences struct {
	Favorites []ProviderModel `json:"favorites"`
	Default   *ProviderModel  `json:"default"` // Pointer to allow null
}

// UIPreferences represents the ui namespace in preferences
type UIPreferences struct {
	Theme         string `json:"theme"`           // "light", "dark", "auto"
	FontSize      *int   `json:"font_size"`       // Pointer to allow null
	CompactMode   *bool  `json:"compact_mode"`    // Pointer to allow null
	ShowWordCount *bool  `json:"show_word_count"` // Pointer to allow null
}

// EditorPreferences represents the editor namespace in preferences
type EditorPreferences struct {
	AutoSave   *bool `json:"auto_save"`   // Pointer to allow null
	WordWrap   *bool `json:"word_wrap"`   // Pointer to allow null
	Spellcheck *bool `json:"spellcheck"`  // Pointer to allow null
}

// NotificationPreferences represents the notifications namespace in preferences
type NotificationPreferences struct {
	EmailUpdates *bool `json:"email_updates"`  // Pointer to allow null
	InAppAlerts  *bool `json:"in_app_alerts"`  // Pointer to allow null
}

// GetModels extracts the models namespace from preferences with type safety
func (up *UserPreferences) GetModels() (*ModelsPreferences, error) {
	if up.Preferences == nil {
		return &ModelsPreferences{Favorites: []ProviderModel{}}, nil
	}

	modelsData, ok := up.Preferences["models"]
	if !ok {
		return &ModelsPreferences{Favorites: []ProviderModel{}}, nil
	}

	// Re-marshal to ensure type safety
	data, err := json.Marshal(modelsData)
	if err != nil {
		return nil, err
	}

	var models ModelsPreferences
	if err := json.Unmarshal(data, &models); err != nil {
		return nil, err
	}

	return &models, nil
}

// SetModels sets the models namespace in preferences
func (up *UserPreferences) SetModels(models *ModelsPreferences) error {
	if up.Preferences == nil {
		up.Preferences = JSONMap{}
	}

	// Convert to map for storage
	data, err := json.Marshal(models)
	if err != nil {
		return err
	}

	var modelsMap map[string]interface{}
	if err := json.Unmarshal(data, &modelsMap); err != nil {
		return err
	}

	up.Preferences["models"] = modelsMap
	return nil
}

// GetUI extracts the ui namespace from preferences
func (up *UserPreferences) GetUI() (*UIPreferences, error) {
	if up.Preferences == nil {
		return &UIPreferences{Theme: "light"}, nil
	}

	uiData, ok := up.Preferences["ui"]
	if !ok {
		return &UIPreferences{Theme: "light"}, nil
	}

	data, err := json.Marshal(uiData)
	if err != nil {
		return nil, err
	}

	var ui UIPreferences
	if err := json.Unmarshal(data, &ui); err != nil {
		return nil, err
	}

	return &ui, nil
}

// SetUI sets the ui namespace in preferences
func (up *UserPreferences) SetUI(ui *UIPreferences) error {
	if up.Preferences == nil {
		up.Preferences = JSONMap{}
	}

	data, err := json.Marshal(ui)
	if err != nil {
		return err
	}

	var uiMap map[string]interface{}
	if err := json.Unmarshal(data, &uiMap); err != nil {
		return err
	}

	up.Preferences["ui"] = uiMap
	return nil
}

// GetSystemInstructions extracts system_instructions from preferences
func (up *UserPreferences) GetSystemInstructions() *string {
	if up.Preferences == nil {
		return nil
	}

	instructions, ok := up.Preferences["system_instructions"]
	if !ok || instructions == nil {
		return nil
	}

	str, ok := instructions.(string)
	if !ok {
		return nil
	}

	return &str
}

// SetSystemInstructions sets system_instructions in preferences
func (up *UserPreferences) SetSystemInstructions(instructions *string) {
	if up.Preferences == nil {
		up.Preferences = JSONMap{}
	}

	if instructions == nil {
		up.Preferences["system_instructions"] = nil
	} else {
		up.Preferences["system_instructions"] = *instructions
	}
}

// OptionalSystemInstructions tracks tri-state semantics for system_instructions updates (RFC 7396 PATCH).
// This is transport-agnostic (no JSON tags) - handler maps from httputil.OptionalString.
//   - Present=false: field absent from request (don't change)
//   - Present=true, Value=nil: field is null (clear)
//   - Present=true, Value=&"": field is empty string
//   - Present=true, Value=&"text": field has value
type OptionalSystemInstructions struct {
	Present bool    // true if field was in request
	Value   *string // nil = clear, non-nil = set (including empty string)
}

// UpdatePreferencesRequest represents the request to update user preferences
// Supports partial updates via pointers - only provided fields are updated
type UpdatePreferencesRequest struct {
	Models             *ModelsPreferences          `json:"models"`        // Update entire models namespace
	UI                 *UIPreferences              `json:"ui"`            // Update entire ui namespace
	Editor             *EditorPreferences          `json:"editor"`        // Update entire editor namespace
	SystemInstructions OptionalSystemInstructions  // Tri-state: absent=don't change, null=clear, value=set (no json tag - mapped from handler DTO)
	Notifications      *NotificationPreferences    `json:"notifications"` // Update entire notifications namespace
}
