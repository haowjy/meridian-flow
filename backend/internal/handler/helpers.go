package handler

import (
	"errors"
	"net/http"

	"meridian/internal/domain"
	"meridian/internal/httputil"
)

// handleError converts domain errors to HTTP responses
func handleError(w http.ResponseWriter, err error) {
	var conflictErr *domain.ConflictError

	switch {
	case errors.Is(err, domain.ErrValidation):
		httputil.RespondError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, domain.ErrNotFound):
		httputil.RespondError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, domain.ErrUnauthorized):
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
	case errors.Is(err, domain.ErrForbidden):
		httputil.RespondError(w, http.StatusForbidden, err.Error())
	case errors.As(err, &conflictErr):
		httputil.RespondError(w, http.StatusConflict, conflictErr.Error())
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
