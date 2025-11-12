package middleware

import (
	"log/slog"

	"github.com/gofiber/fiber/v2"
)

// errorTypeFromStatus maps HTTP status codes to RFC 7807 error types
func errorTypeFromStatus(status int) string {
	switch status {
	case fiber.StatusBadRequest:
		return "validation-error"
	case fiber.StatusUnauthorized:
		return "unauthorized"
	case fiber.StatusForbidden:
		return "forbidden"
	case fiber.StatusNotFound:
		return "not-found"
	case fiber.StatusConflict:
		return "conflict"
	case fiber.StatusInternalServerError:
		return "internal-error"
	default:
		return "error"
	}
}

// errorTitleFromStatus maps HTTP status codes to RFC 7807 error titles
func errorTitleFromStatus(status int) string {
	switch status {
	case fiber.StatusBadRequest:
		return "Bad Request"
	case fiber.StatusUnauthorized:
		return "Unauthorized"
	case fiber.StatusForbidden:
		return "Forbidden"
	case fiber.StatusNotFound:
		return "Not Found"
	case fiber.StatusConflict:
		return "Conflict"
	case fiber.StatusInternalServerError:
		return "Internal Server Error"
	default:
		return "Error"
	}
}

// ErrorHandler is a custom error handler for Fiber that returns RFC 7807 Problem Details
func ErrorHandler(c *fiber.Ctx, err error) error {
	// Default to 500 Internal Server Error
	code := fiber.StatusInternalServerError
	message := "Internal Server Error"

	// Check if it's a Fiber error
	if e, ok := err.(*fiber.Error); ok {
		code = e.Code
		message = e.Message
	}

	// Build log fields with request context
	logFields := []any{
		"code", code,
		"message", message,
		"path", c.Path(),
		"method", c.Method(),
	}

	// Add user context if available
	if userID, ok := c.Locals("userID").(string); ok && userID != "" {
		logFields = append(logFields, "user_id", userID)
	}
	if projectID, ok := c.Locals("projectID").(string); ok && projectID != "" {
		logFields = append(logFields, "project_id", projectID)
	}

	// Log at appropriate level based on status code
	if code >= 500 {
		slog.Error("server error", logFields...)
	} else if code >= 400 {
		slog.Warn("client error", logFields...)
	}

	// Return RFC 7807 Problem Details response
	c.Set("Content-Type", "application/problem+json")
	return c.Status(code).JSON(fiber.Map{
		"type":   errorTypeFromStatus(code),
		"title":  errorTitleFromStatus(code),
		"status": code,
		"detail": message,
	})
}

