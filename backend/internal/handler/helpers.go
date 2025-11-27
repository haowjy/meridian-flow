package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"meridian/internal/domain"
	"meridian/internal/httputil"
)

// PathParam extracts a required path parameter, returning false if missing.
// Writes 400 error response if the parameter is empty.
func PathParam(w http.ResponseWriter, r *http.Request, name, resourceName string) (string, bool) {
	value := r.PathValue(name)
	if value == "" {
		httputil.RespondError(w, http.StatusBadRequest, resourceName+" is required")
		return "", false
	}
	return value, true
}

// QueryInt parses an optional integer query parameter with bounds checking.
// Returns defaultVal if missing, invalid, or out of bounds.
func QueryInt(r *http.Request, name string, defaultVal, min, max int) int {
	if val := r.URL.Query().Get(name); val != "" {
		if parsed, err := strconv.Atoi(val); err == nil && parsed >= min && parsed <= max {
			return parsed
		}
	}
	return defaultVal
}

// handleError converts domain errors to HTTP responses.
// Uses HTTPError interface for extensible error handling (OCP compliance).
// New error types can be added by implementing HTTPError interface without modifying this function.
func handleError(w http.ResponseWriter, err error) {
	// Try to use HTTPError interface (supports new error types without modification)
	var httpErr domain.HTTPError
	if errors.As(err, &httpErr) {
		httputil.RespondError(w, httpErr.StatusCode(), httpErr.Error())
		return
	}

	// Fallback: Check sentinel errors for backwards compatibility
	switch {
	case errors.Is(err, domain.ErrValidation):
		httputil.RespondError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, domain.ErrNotFound):
		httputil.RespondError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, domain.ErrUnauthorized):
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
	case errors.Is(err, domain.ErrForbidden):
		httputil.RespondError(w, http.StatusForbidden, err.Error())
	default:
		httputil.RespondError(w, http.StatusInternalServerError, "internal server error")
	}
}

// HandleCreateConflict handles conflicts during creation by returning the existing resource with 409.
// If the error is a ConflictError, extracts the resourceID and calls fetchByID to retrieve the existing resource.
func HandleCreateConflict[T any](w http.ResponseWriter, err error, fetchByID func(resourceID string) (*T, error)) {
	var conflictErr *domain.ConflictError
	if !errors.As(err, &conflictErr) {
		// Not a conflict error, handle normally
		handleError(w, err)
		return
	}

	// Try to fetch existing resource by ID from conflict error
	existing, fetchErr := fetchByID(conflictErr.ResourceID)
	if fetchErr != nil {
		handleError(w, fetchErr)
		return
	}

	// Return existing resource with 409 status
	httputil.RespondJSON(w, http.StatusConflict, existing)
}

// parseUUID parses a string into a UUID
func parseUUID(s string) (uuid.UUID, error) {
	return uuid.Parse(s)
}
