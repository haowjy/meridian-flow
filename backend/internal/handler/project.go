package handler

import (
	"log/slog"

	"github.com/gofiber/fiber/v2"
	"meridian/internal/domain/services"
)

// ProjectHandler handles project HTTP requests
type ProjectHandler struct {
	projectService services.ProjectService
	logger         *slog.Logger
}

// NewProjectHandler creates a new project handler
func NewProjectHandler(projectService services.ProjectService, logger *slog.Logger) *ProjectHandler {
	return &ProjectHandler{
		projectService: projectService,
		logger:         logger,
	}
}

// ListProjects retrieves all projects for the user
// GET /api/projects
func (h *ProjectHandler) ListProjects(c *fiber.Ctx) error {
	// Extract user ID from context
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Call service
	projects, err := h.projectService.ListProjects(c.Context(), userID)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(projects)
}

// CreateProject creates a new project
// POST /api/projects
func (h *ProjectHandler) CreateProject(c *fiber.Ctx) error {
	// Extract user ID from context
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	// Parse request
	var req services.CreateProjectRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}
	req.UserID = userID

	// Call service (all business logic is here)
	project, err := h.projectService.CreateProject(c.Context(), &req)
	if err != nil {
		return handleError(c, err)
	}

	return c.Status(fiber.StatusCreated).JSON(project)
}

// GetProject retrieves a project by ID
// GET /api/projects/:id
func (h *ProjectHandler) GetProject(c *fiber.Ctx) error {
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id := c.Params("id")
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Project ID is required")
	}

	project, err := h.projectService.GetProject(c.Context(), id, userID)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(project)
}

// UpdateProject updates a project
// PATCH /api/projects/:id
func (h *ProjectHandler) UpdateProject(c *fiber.Ctx) error {
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id := c.Params("id")
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Project ID is required")
	}

	var req services.UpdateProjectRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Invalid request body")
	}

	project, err := h.projectService.UpdateProject(c.Context(), id, userID, &req)
	if err != nil {
		return handleError(c, err)
	}

	return c.JSON(project)
}

// DeleteProject deletes a project
// DELETE /api/projects/:id
func (h *ProjectHandler) DeleteProject(c *fiber.Ctx) error {
	userID, err := getUserID(c)
	if err != nil {
		return fiber.NewError(fiber.StatusUnauthorized, err.Error())
	}

	id := c.Params("id")
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "Project ID is required")
	}

	err = h.projectService.DeleteProject(c.Context(), id, userID)
	if err != nil {
		return handleError(c, err)
	}

	return c.SendStatus(fiber.StatusNoContent)
}
