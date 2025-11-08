package handler

import (
	"errors"
	"fmt"
	"log/slog"

	"github.com/gofiber/fiber/v2"
	"meridian/internal/domain"
)

// RFC 7807 Problem Details for HTTP APIs
// https://datatracker.ietf.org/doc/html/rfc7807

// ProblemDetail represents a standard RFC 7807 error response
type ProblemDetail struct {
	Type   string `json:"type"`             // Error type identifier (e.g., "validation-error")
	Title  string `json:"title"`            // Short, human-readable summary
	Status int    `json:"status"`           // HTTP status code
	Detail string `json:"detail,omitempty"` // Human-readable explanation of this specific error
}

// InvalidParam represents a single validation error for a field
type InvalidParam struct {
	Name   string `json:"name"`   // Field name
	Reason string `json:"reason"` // Why the field is invalid
}

// ValidationProblem extends ProblemDetail with field-level validation errors
type ValidationProblem struct {
	Type          string         `json:"type"`
	Title         string         `json:"title"`
	Status        int            `json:"status"`
	Detail        string         `json:"detail,omitempty"`
	InvalidParams []InvalidParam `json:"invalid_params,omitempty"` // Field-level validation errors
}

// ConflictProblem extends ProblemDetail with the existing resource (custom extension per RFC 7807)
// Used for CREATE operations that conflict with existing resources
type ConflictProblem[T any] struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Status   int    `json:"status"`
	Detail   string `json:"detail,omitempty"`
	Resource T      `json:"resource"` // The existing resource in same format as GET endpoint
}

// HandleCreateConflict handles conflict errors for create operations by fetching and returning the existing resource
// If the error is a ConflictError, it fetches the existing resource and returns 409 with ConflictProblem response
// Otherwise, it delegates to standard error handling
func HandleCreateConflict[T any](c *fiber.Ctx, err error, fetchFunc func() (T, error)) error {
	var conflictErr *domain.ConflictError
	if errors.As(err, &conflictErr) {
		// Fetch the existing resource
		existing, fetchErr := fetchFunc()
		if fetchErr != nil {
			// Failed to fetch existing - fall back to standard error handling
			return handleError(c, fetchErr)
		}
		// Return 409 with RFC 7807 ConflictProblem + full existing resource
		c.Set("Content-Type", "application/problem+json")
		return c.Status(fiber.StatusConflict).JSON(ConflictProblem[T]{
			Type:     "conflict",
			Title:    "Resource Already Exists",
			Status:   fiber.StatusConflict,
			Detail:   conflictErr.Message,
			Resource: existing,
		})
	}

	// Not a conflict error - use standard error handling
	return handleError(c, err)
}

// handleError maps domain errors to HTTP responses
// Returns nil if error was handled (response sent), otherwise returns fiber error
func handleError(c *fiber.Ctx, err error) error {
	return mapErrorToHTTP(err)
}

// mapErrorToHTTP maps domain errors to HTTP status codes
func mapErrorToHTTP(err error) error {
	switch {
	case errors.Is(err, domain.ErrNotFound):
		return fiber.NewError(fiber.StatusNotFound, "Resource not found")
	case errors.Is(err, domain.ErrConflict):
		return fiber.NewError(fiber.StatusConflict, err.Error())
	case errors.Is(err, domain.ErrValidation):
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	case errors.Is(err, domain.ErrUnauthorized):
		return fiber.NewError(fiber.StatusUnauthorized, "Unauthorized")
	case errors.Is(err, domain.ErrForbidden):
		return fiber.NewError(fiber.StatusForbidden, "Forbidden")
	default:
		slog.Error("unmapped error in mapErrorToHTTP",
			"error", err,
			"error_type", fmt.Sprintf("%T", err),
		)
		return fiber.NewError(fiber.StatusInternalServerError, "Internal server error")
	}
}
