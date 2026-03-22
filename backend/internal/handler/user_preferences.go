package handler

import (
	"log/slog"
	"meridian/internal/domain"
	"net/http"

	"meridian/internal/config"

	"meridian/internal/httputil"
	"meridian/internal/optional"
)

// UserPreferencesHandler handles user preferences HTTP requests
type UserPreferencesHandler struct {
	service domain.UserPreferencesService
	logger  *slog.Logger
	config  *config.Config
}

// NewUserPreferencesHandler creates a new user preferences handler
func NewUserPreferencesHandler(service domain.UserPreferencesService, logger *slog.Logger, cfg *config.Config) *UserPreferencesHandler {
	return &UserPreferencesHandler{
		service: service,
		logger:  logger,
		config:  cfg,
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
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, prefs)
}

// updatePreferencesDTO is the transport-layer request for PATCH /api/users/me/preferences.
// Uses optional.Optional[string] for system_instructions to support tri-state PATCH semantics (RFC 7396):
//   - field absent = don't change
//   - field null = clear
//   - field has value = set
type updatePreferencesDTO struct {
	Models             *domain.ModelsPreferences       `json:"models"`
	UI                 *domain.UIPreferences           `json:"ui"`
	Editor             *domain.EditorPreferences       `json:"editor"`
	SystemInstructions optional.Optional[string]       `json:"system_instructions"`
	Notifications      *domain.NotificationPreferences `json:"notifications"`
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
	req := &domain.UpdatePreferencesRequest{
		Models:             dto.Models,
		UI:                 dto.UI,
		Editor:             dto.Editor,
		Notifications:      dto.Notifications,
		SystemInstructions: dto.SystemInstructions,
	}

	// Update preferences
	prefs, err := h.service.UpdatePreferences(r.Context(), uuid, req)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, prefs)
}
