package handler

import (
	"fmt"

	"github.com/gofiber/fiber/v2"
)

// getProjectID extracts the project ID from the context
func getProjectID(c *fiber.Ctx) (string, error) {
	projectID, ok := c.Locals("projectID").(string)
	if !ok || projectID == "" {
		return "", fmt.Errorf("project ID not found in context")
	}
	return projectID, nil
}

// getUserID extracts the user ID from the context
func getUserID(c *fiber.Ctx) (string, error) {
	userID, ok := c.Locals("userID").(string)
	if !ok || userID == "" {
		return "", fmt.Errorf("user ID not found in context")
	}
	return userID, nil
}
