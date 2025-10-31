package middleware

import (
	"log/slog"

	"github.com/gofiber/fiber/v2"
)

// ErrorHandler is a custom error handler for Fiber
func ErrorHandler(c *fiber.Ctx, err error) error {
	// Default to 500 Internal Server Error
	code := fiber.StatusInternalServerError
	message := "Internal Server Error"

	// Check if it's a Fiber error
	if e, ok := err.(*fiber.Error); ok {
		code = e.Code
		message = e.Message
		slog.Info("fiber error",
			"code", code,
			"message", message,
			"path", c.Path(),
			"method", c.Method(),
		)
	} else {
		// Log unexpected errors
		slog.Error("unexpected error",
			"error", err,
			"path", c.Path(),
			"method", c.Method(),
		)
	}

	// Send JSON error response
	return c.Status(code).JSON(fiber.Map{
		"error": message,
		"code":  code,
	})
}

