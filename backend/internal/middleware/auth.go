package middleware

import (
	"github.com/gofiber/fiber/v2"
)

// AuthMiddleware is a simple auth stub that sets a test user ID
// In Phase 2, this will be replaced with real Supabase auth
func AuthMiddleware(testUserID string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// For now, just set a test user ID in the context
		// Later, this will validate JWT tokens from Supabase
		c.Locals("userID", testUserID)
		return c.Next()
	}
}

