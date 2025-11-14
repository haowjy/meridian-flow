package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"meridian/internal/domain"
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
	userID, err := getUserID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

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
	userID, err := getUserID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

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
		// Handle conflict by fetching and returning existing project with 409
		HandleCreateConflict(w, err, func() (*docsystem.Project, error) {
			// Get ConflictError to extract resource ID
			var conflictErr *domain.ConflictError
			if errors.As(err, &conflictErr) {
				return h.projectService.GetProject(r.Context(), conflictErr.ResourceID, userID)
			}
			return nil, err
		})
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, project)
}

// GetProject retrieves a project by ID
// GET /api/projects/{id}
func (h *ProjectHandler) GetProject(w http.ResponseWriter, r *http.Request) {
	userID, err := getUserID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Project ID is required")
		return
	}

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
	userID, err := getUserID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Project ID is required")
		return
	}

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
	userID, err := getUserID(r)
	if err != nil {
		httputil.RespondError(w, http.StatusUnauthorized, err.Error())
		return
	}

	id := r.PathValue("id")
	if id == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Project ID is required")
		return
	}

	project, err := h.projectService.DeleteProject(r.Context(), id, userID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, project)
}
