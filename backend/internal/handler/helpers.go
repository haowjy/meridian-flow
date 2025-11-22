package handler

import (
	"errors"
	"net/http"

	"github.com/google/uuid"
	"meridian/internal/domain"
	"meridian/internal/httputil"
)

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

// HandleCreateConflict handles conflicts during creation by returning the existing resource with 409
// If the error is a ConflictError, it calls fetchFn to retrieve the existing resource
func HandleCreateConflict[T any](w http.ResponseWriter, err error, fetchFn func() (*T, error)) {
	var conflictErr *domain.ConflictError
	if errors.As(err, &conflictErr) {
		// Try to fetch existing resource
		existing, fetchErr := fetchFn()
		if fetchErr != nil {
			handleError(w, fetchErr)
			return
		}

		// Return existing resource with 409 status
		httputil.RespondJSON(w, http.StatusConflict, existing)
		return
	}

	// Not a conflict error, handle normally
	handleError(w, err)
}

// parseUUID parses a string into a UUID
func parseUUID(s string) (uuid.UUID, error) {
	return uuid.Parse(s)
}
