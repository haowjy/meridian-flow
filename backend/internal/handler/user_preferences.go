package handler

import (
	"log/slog"
	"net/http"

	"meridian/internal/domain/models"
	"meridian/internal/domain/services"
	"meridian/internal/httputil"
)

// UserPreferencesHandler handles user preferences HTTP requests
type UserPreferencesHandler struct {
	service services.UserPreferencesService
	logger  *slog.Logger
}

// NewUserPreferencesHandler creates a new user preferences handler
func NewUserPreferencesHandler(service services.UserPreferencesService, logger *slog.Logger) *UserPreferencesHandler {
	return &UserPreferencesHandler{
		service: service,
		logger:  logger,
	}
}

// GetPreferences retrieves user preferences
// GET /api/users/me/preferences
func (h *UserPreferencesHandler) GetPreferences(w http.ResponseWriter, r *http.Request) {
	// Extract user ID from context
	userID := httputil.GetUserID(r)

	// Parse UUID
	uuid, err := parseUUID(userID)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid user ID format")
		return
	}

	// Get preferences
	prefs, err := h.service.GetPreferences(r.Context(), uuid)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, prefs)
}

// updatePreferencesDTO is the transport-layer request for PATCH /api/users/me/preferences.
// Uses httputil.OptionalString for system_instructions to support tri-state PATCH semantics (RFC 7396):
//   - field absent = don't change
//   - field null = clear
//   - field has value = set
type updatePreferencesDTO struct {
	Models             *models.ModelsPreferences       `json:"models"`
	UI                 *models.UIPreferences           `json:"ui"`
	Editor             *models.EditorPreferences       `json:"editor"`
	SystemInstructions httputil.OptionalString         `json:"system_instructions"`
	Notifications      *models.NotificationPreferences `json:"notifications"`
}

// UpdatePreferences updates user preferences
// PATCH /api/users/me/preferences
func (h *UserPreferencesHandler) UpdatePreferences(w http.ResponseWriter, r *http.Request) {
	// Extract user ID from context
	userID := httputil.GetUserID(r)

	// Parse UUID
	uuid, err := parseUUID(userID)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid user ID format")
		return
	}

	// Parse request into transport DTO
	var dto updatePreferencesDTO
	if err := httputil.ParseJSON(w, r, &dto); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Map transport DTO to service request
	req := &models.UpdatePreferencesRequest{
		Models:        dto.Models,
		UI:            dto.UI,
		Editor:        dto.Editor,
		Notifications: dto.Notifications,
		SystemInstructions: models.OptionalSystemInstructions{
			Present: dto.SystemInstructions.Present,
			Value:   dto.SystemInstructions.Value,
		},
	}

	// Update preferences
	prefs, err := h.service.UpdatePreferences(r.Context(), uuid, req)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, prefs)
}
