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

	// Parse request
	var req models.UpdatePreferencesRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Update preferences
	prefs, err := h.service.UpdatePreferences(r.Context(), uuid, &req)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, prefs)
}
