package handlers

import (
	"github.com/gofiber/fiber/v2"
	"github.com/jimmyyao/meridian/backend/internal/database"
)

// GetTree returns the nested folder/document tree for a project
func GetTree(db *database.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// Get project ID from context (injected by auth middleware)
		projectID, ok := c.Locals("projectID").(string)
		if !ok || projectID == "" {
			return fiber.NewError(fiber.StatusInternalServerError, "Project ID not found in context")
		}

		// Build the tree
		tree, err := db.BuildTree(projectID)
		if err != nil {
			return fiber.NewError(fiber.StatusInternalServerError, err.Error())
		}

		return c.JSON(tree)
	}
}

