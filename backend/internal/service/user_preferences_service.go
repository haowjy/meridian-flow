package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"meridian/internal/domain/models"
	"meridian/internal/domain/repositories"
	"meridian/internal/domain/services"
)

// UserPreferencesService implements the UserPreferencesService interface
type UserPreferencesService struct {
	prefsRepo repositories.UserPreferencesRepository
	logger    *slog.Logger
}

// NewUserPreferencesService creates a new user preferences service
func NewUserPreferencesService(
	prefsRepo repositories.UserPreferencesRepository,
	logger *slog.Logger,
) services.UserPreferencesService {
	return &UserPreferencesService{
		prefsRepo: prefsRepo,
		logger:    logger,
	}
}

// getDefaultPreferences returns default preferences with namespaced structure
func (s *UserPreferencesService) getDefaultPreferences(userID uuid.UUID) *models.UserPreferences {
	now := time.Now()
	return &models.UserPreferences{
		UserID: userID,
		Preferences: models.JSONMap{
			"models": map[string]interface{}{
				"favorites": []models.ProviderModel{},
				"default":   nil,
			},
			"ui": map[string]interface{}{
				"theme": "light",
			},
			"editor":              map[string]interface{}{},
			"system_instructions": nil,
			"notifications":       map[string]interface{}{},
		},
		CreatedAt: now,
		UpdatedAt: now,
	}
}

// GetPreferences retrieves preferences for a user
func (s *UserPreferencesService) GetPreferences(ctx context.Context, userID uuid.UUID) (*models.UserPreferences, error) {
	prefs, err := s.prefsRepo.GetByUserID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get preferences: %w", err)
	}

	// If no preferences exist yet, return default/empty preferences
	if prefs == nil {
		s.logger.Debug("no preferences found, returning defaults", "user_id", userID)
		prefs = s.getDefaultPreferences(userID)
	}

	return prefs, nil
}

// UpdatePreferences updates user preferences (partial or full update)
func (s *UserPreferencesService) UpdatePreferences(ctx context.Context, userID uuid.UUID, req *models.UpdatePreferencesRequest) (*models.UserPreferences, error) {
	// Get existing preferences or create new ones
	existing, err := s.prefsRepo.GetByUserID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get existing preferences: %w", err)
	}

	// If no existing preferences, start with defaults
	if existing == nil {
		existing = s.getDefaultPreferences(userID)
	}

	// Ensure preferences map is initialized
	if existing.Preferences == nil {
		existing.Preferences = models.JSONMap{}
	}

	// Apply partial updates (only update namespaces that are provided)
	if req.Models != nil {
		if err := s.updateModelsNamespace(existing, req.Models); err != nil {
			return nil, fmt.Errorf("update models namespace: %w", err)
		}
	}

	if req.UI != nil {
		if err := s.updateUINamespace(existing, req.UI); err != nil {
			return nil, fmt.Errorf("update ui namespace: %w", err)
		}
	}

	if req.Editor != nil {
		if err := s.updateEditorNamespace(existing, req.Editor); err != nil {
			return nil, fmt.Errorf("update editor namespace: %w", err)
		}
	}

	// Tri-state: only update if field was present in request
	if req.SystemInstructions.Present {
		existing.SetSystemInstructions(req.SystemInstructions.Value)
	}

	if req.Notifications != nil {
		if err := s.updateNotificationsNamespace(existing, req.Notifications); err != nil {
			return nil, fmt.Errorf("update notifications namespace: %w", err)
		}
	}

	// Update timestamp
	existing.UpdatedAt = time.Now()

	// Persist changes
	if err := s.prefsRepo.Upsert(ctx, existing); err != nil {
		return nil, fmt.Errorf("upsert preferences: %w", err)
	}

	s.logger.Info("user preferences updated",
		"user_id", userID,
		"has_models", req.Models != nil,
		"has_ui", req.UI != nil,
		"has_editor", req.Editor != nil,
		"has_system_instructions", req.SystemInstructions.Present,
		"has_notifications", req.Notifications != nil,
	)

	return existing, nil
}

// updateModelsNamespace updates the models namespace in preferences
func (s *UserPreferencesService) updateModelsNamespace(prefs *models.UserPreferences, models *models.ModelsPreferences) error {
	// Convert to map for storage
	data, err := json.Marshal(models)
	if err != nil {
		return err
	}

	var modelsMap map[string]interface{}
	if err := json.Unmarshal(data, &modelsMap); err != nil {
		return err
	}

	prefs.Preferences["models"] = modelsMap
	return nil
}

// updateUINamespace updates the ui namespace in preferences
func (s *UserPreferencesService) updateUINamespace(prefs *models.UserPreferences, ui *models.UIPreferences) error {
	data, err := json.Marshal(ui)
	if err != nil {
		return err
	}

	var uiMap map[string]interface{}
	if err := json.Unmarshal(data, &uiMap); err != nil {
		return err
	}

	prefs.Preferences["ui"] = uiMap
	return nil
}

// updateEditorNamespace updates the editor namespace in preferences
func (s *UserPreferencesService) updateEditorNamespace(prefs *models.UserPreferences, editor *models.EditorPreferences) error {
	data, err := json.Marshal(editor)
	if err != nil {
		return err
	}

	var editorMap map[string]interface{}
	if err := json.Unmarshal(data, &editorMap); err != nil {
		return err
	}

	prefs.Preferences["editor"] = editorMap
	return nil
}

// updateNotificationsNamespace updates the notifications namespace in preferences
func (s *UserPreferencesService) updateNotificationsNamespace(prefs *models.UserPreferences, notifications *models.NotificationPreferences) error {
	data, err := json.Marshal(notifications)
	if err != nil {
		return err
	}

	var notificationsMap map[string]interface{}
	if err := json.Unmarshal(data, &notificationsMap); err != nil {
		return err
	}

	prefs.Preferences["notifications"] = notificationsMap
	return nil
}
