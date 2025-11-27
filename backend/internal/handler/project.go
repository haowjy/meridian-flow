package handler

import (
	"log/slog"
	"net/http"

	"meridian/internal/domain/models/docsystem"
	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/httputil"
)

// ProjectHandler handles project HTTP requests
type ProjectHandler struct {
	projectService docsysSvc.ProjectService
	logger         *slog.Logger
}

// NewProjectHandler creates a new project handler
func NewProjectHandler(projectService docsysSvc.ProjectService, logger *slog.Logger) *ProjectHandler {
	return &ProjectHandler{
		projectService: projectService,
		logger:         logger,
	}
}

// ListProjects retrieves all projects for the user
// GET /api/projects
func (h *ProjectHandler) ListProjects(w http.ResponseWriter, r *http.Request) {
	// Extract user ID from context
	userID := httputil.GetUserID(r)

	// Call service
	projects, err := h.projectService.ListProjects(r.Context(), userID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, projects)
}

// CreateProject creates a new project
// POST /api/projects
// Returns 201 if created, 409 with existing project if duplicate
func (h *ProjectHandler) CreateProject(w http.ResponseWriter, r *http.Request) {
	// Extract user ID from context
	userID := httputil.GetUserID(r)

	// Parse request
	var req docsysSvc.CreateProjectRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.UserID = userID

	// Call service (all business logic is here)
	project, err := h.projectService.CreateProject(r.Context(), &req)
	if err != nil {
		HandleCreateConflict(w, err, func(id string) (*docsystem.Project, error) {
			return h.projectService.GetProject(r.Context(), id, userID)
		})
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, project)
}

// GetProject retrieves a project by ID
// GET /api/projects/{id}
func (h *ProjectHandler) GetProject(w http.ResponseWriter, r *http.Request) {
	id, ok := PathParam(w, r, "id", "Project ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	project, err := h.projectService.GetProject(r.Context(), id, userID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, project)
}

// UpdateProject updates a project
// PATCH /api/projects/{id}
func (h *ProjectHandler) UpdateProject(w http.ResponseWriter, r *http.Request) {
	id, ok := PathParam(w, r, "id", "Project ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	var req docsysSvc.UpdateProjectRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	project, err := h.projectService.UpdateProject(r.Context(), id, userID, &req)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, project)
}

// DeleteProject soft-deletes a project and returns it with deleted_at timestamp
// DELETE /api/projects/{id}
func (h *ProjectHandler) DeleteProject(w http.ResponseWriter, r *http.Request) {
	id, ok := PathParam(w, r, "id", "Project ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)
	project, err := h.projectService.DeleteProject(r.Context(), id, userID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, project)
}
