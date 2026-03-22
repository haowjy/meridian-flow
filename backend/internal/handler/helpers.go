package handler

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/google/uuid"
	"meridian/internal/config"
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

func domainErrorStatusCode(err error) (int, bool) {
	var notFoundErr *domain.NotFoundError
	if errors.As(err, &notFoundErr) {
		return http.StatusNotFound, true
	}

	var validationErr *domain.ValidationError
	if errors.As(err, &validationErr) {
		return http.StatusBadRequest, true
	}

	var unauthorizedErr *domain.UnauthorizedError
	if errors.As(err, &unauthorizedErr) {
		return http.StatusUnauthorized, true
	}

	var forbiddenErr *domain.ForbiddenError
	if errors.As(err, &forbiddenErr) {
		return http.StatusForbidden, true
	}

	var insufficientCreditsErr *domain.InsufficientCreditsError
	if errors.As(err, &insufficientCreditsErr) {
		return http.StatusPaymentRequired, true
	}

	var rateLimitErr *domain.RateLimitError
	if errors.As(err, &rateLimitErr) {
		return http.StatusTooManyRequests, true
	}

	var conflictErr *domain.ConflictError
	if errors.As(err, &conflictErr) {
		return http.StatusConflict, true
	}

	var constraintErr *domain.ConstraintViolationError
	if errors.As(err, &constraintErr) {
		return http.StatusBadRequest, true
	}

	return 0, false
}

// handleError converts domain errors to HTTP responses.
func handleError(w http.ResponseWriter, err error, cfg *config.Config) {
	if statusCode, ok := domainErrorStatusCode(err); ok {
		message := err.Error()

		// In dev/test, add internal details for ConstraintViolationError
		if !cfg.IsProd() {
			var constraintErr *domain.ConstraintViolationError
			if errors.As(err, &constraintErr) && constraintErr.InternalDetail != "" {
				message = fmt.Sprintf("%s (debug: %s)", message, constraintErr.InternalDetail)
			}
		}

		// For ValidationError with field, include field in response extras for frontend routing
		var insufficientCreditsErr *domain.InsufficientCreditsError
		if errors.As(err, &insufficientCreditsErr) {
			httputil.RespondErrorWithExtras(w, statusCode, message, map[string]interface{}{
				"balance_millicredits":   insufficientCreditsErr.BalanceMillicredits,
				"required_millicredits":  insufficientCreditsErr.RequiredMillicredits,
				"shortfall_millicredits": insufficientCreditsErr.ShortfallMillicredits,
			})
			return
		}

		var validationErr *domain.ValidationError
		if errors.As(err, &validationErr) && validationErr.Field != "" {
			httputil.RespondErrorWithExtras(w, statusCode, message, map[string]interface{}{
				"field": validationErr.Field,
			})
			return
		}

		httputil.RespondError(w, statusCode, message)
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
	case errors.Is(err, domain.ErrInsufficientCredits):
		httputil.RespondError(w, http.StatusPaymentRequired, err.Error())
	default:
		// Log unhandled error for debugging
		slog.Error("unhandled error in handleError",
			"error", err,
			"error_type", fmt.Sprintf("%T", err),
		)

		// In dev/test, expose error type to help debugging
		message := "internal server error"
		if !cfg.IsProd() {
			message = fmt.Sprintf("internal server error (type: %T, error: %v)", err, err)
		}
		httputil.RespondError(w, http.StatusInternalServerError, message)
	}
}

// HandleCreateConflict handles conflicts during creation by returning the existing resource with 409.
// If the error is a ConflictError, extracts the resourceID and calls fetchByID to retrieve the existing resource.
// Returns RFC 7807 Problem Details format with `resource` field for frontend compatibility.
func HandleCreateConflict[T any](w http.ResponseWriter, err error, cfg *config.Config, fetchByID func(resourceID string) (*T, error)) {
	var conflictErr *domain.ConflictError
	if !errors.As(err, &conflictErr) {
		// Not a conflict error, handle normally
		handleError(w, err, cfg)
		return
	}

	// Try to fetch existing resource by ID from conflict error
	existing, fetchErr := fetchByID(conflictErr.ResourceID)
	if fetchErr != nil {
		handleError(w, fetchErr, cfg)
		return
	}

	// Return existing resource with 409 status in RFC 7807 format
	httputil.RespondErrorWithExtras(w, http.StatusConflict,
		conflictErr.Message,
		map[string]interface{}{
			"resource": existing,
		})
}

// parseUUID parses a string into a UUID
func parseUUID(s string) (uuid.UUID, error) {
	return uuid.Parse(s)
}
