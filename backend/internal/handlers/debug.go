package handlers

import (
	"fmt"
	"github.com/gofiber/fiber/v2"
	"github.com/jimmyyao/meridian/backend/internal/database"
)

// DebugDocuments shows raw document data from database
func DebugDocuments(db *database.DB) fiber.Handler {
	return func(c *fiber.Ctx) error {
		projectID, ok := c.Locals("projectID").(string)
		if !ok || projectID == "" {
			return fiber.NewError(fiber.StatusInternalServerError, "Project ID not found")
		}

		// Get raw data directly from database
		query := fmt.Sprintf(`
			SELECT id, name, folder_id, word_count 
			FROM %s 
			WHERE project_id = $1
			ORDER BY name
		`, db.Tables.Documents)

		rows, err := db.Query(query, projectID)
		if err != nil {
			return c.JSON(fiber.Map{"error": err.Error()})
		}
		defer rows.Close()

		var results []fiber.Map
		for rows.Next() {
			var id, name string
			var folderID *string
			var wordCount int

			if err := rows.Scan(&id, &name, &folderID, &wordCount); err != nil {
				return c.JSON(fiber.Map{"error": err.Error()})
			}

			folderIDStr := "null"
			if folderID != nil {
				folderIDStr = *folderID
			}

			results = append(results, fiber.Map{
				"id":         id,
				"name":       name,
				"folder_id":  folderIDStr,
				"word_count": wordCount,
			})
		}

		return c.JSON(fiber.Map{
			"total":     len(results),
			"documents": results,
		})
	}
}
