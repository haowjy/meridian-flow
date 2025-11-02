package handler

import (
	"errors"
	"fmt"
	"log/slog"

	"github.com/gofiber/fiber/v2"
	"meridian/internal/domain"
)

// ConflictDetail provides structured information about a resource conflict
type ConflictDetail struct {
	Type         string `json:"type"`          // Always "duplicate" for now
	ResourceType string `json:"resource_type"` // "document", "folder", or "project"
	ResourceID   string `json:"resource_id"`   // ID of the conflicting resource
	Location     string `json:"location"`      // API path to the conflicting resource
}

// ConflictResponse represents a 409 conflict response with structured details
type ConflictResponse struct {
	Error    string          `json:"error"`              // Human-readable error message
	Conflict *ConflictDetail `json:"conflict,omitempty"` // Optional structured conflict details
}

// handleError maps domain errors to HTTP responses
// Returns nil if error was handled (response sent), otherwise returns fiber error
func handleError(c *fiber.Ctx, err error) error {
	// Check for structured ConflictError first
	var conflictErr *domain.ConflictError
	if errors.As(err, &conflictErr) {
		// Return structured conflict response with resource ID
		return c.Status(fiber.StatusConflict).JSON(ConflictResponse{
			Error: conflictErr.Message,
			Conflict: &ConflictDetail{
				Type:         "duplicate",
				ResourceType: conflictErr.ResourceType,
				ResourceID:   conflictErr.ResourceID,
				Location:     fmt.Sprintf("/api/%ss/%s", conflictErr.ResourceType, conflictErr.ResourceID),
			},
		})
	}

	// Fall back to standard error mapping
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
