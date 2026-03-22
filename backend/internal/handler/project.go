package handler

import (
	"log/slog"
	"net/http"

	"meridian/internal/config"
	domaindocsys "meridian/internal/domain/docsystem"
	identifier "meridian/internal/domain/identifier"
	"meridian/internal/httputil"
	"meridian/internal/optional"
)

// ProjectHandler handles project HTTP requests
type ProjectHandler struct {
	projectService  domaindocsys.ProjectService
	favoriteService domaindocsys.FavoriteService
	resolver        identifier.Resolver
	logger          *slog.Logger
	config          *config.Config
}

// NewProjectHandler creates a new project handler
func NewProjectHandler(
	projectService domaindocsys.ProjectService,
	favoriteService domaindocsys.FavoriteService,
	resolver identifier.Resolver,
	logger *slog.Logger,
	cfg *config.Config,
) *ProjectHandler {
	return &ProjectHandler{
		projectService:  projectService,
		favoriteService: favoriteService,
		resolver:        resolver,
		logger:          logger,
		config:          cfg,
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
		handleError(w, err, h.config)
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
	var req domaindocsys.CreateProjectRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	req.UserID = userID

	// Call service (all business logic is here)
	project, err := h.projectService.CreateProject(r.Context(), &req)
	if err != nil {
		HandleCreateConflict(w, err, h.config, func(id string) (*domaindocsys.Project, error) {
			return h.projectService.GetProject(r.Context(), id, userID)
		})
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, project)
}

// GetProject retrieves a project by ID or slug
// GET /api/projects/{id}
func (h *ProjectHandler) GetProject(w http.ResponseWriter, r *http.Request) {
	identifier, ok := PathParam(w, r, "id", "Project ID or slug")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	// Resolve identifier (UUID or slug) to project UUID
	projectID, err := h.resolver.ResolveProject(r.Context(), identifier, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	project, err := h.projectService.GetProject(r.Context(), projectID, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, project)
}

// preferencesDTO is the request body for project preferences
type preferencesDTO struct {
	DisabledTools []string `json:"disabled_tools,omitempty"` // snake_case for API
}

// updateProjectDTO is the transport-layer request for PATCH /api/projects/{id}.
// Uses optional.Optional[string] for system_prompt to support tri-state PATCH semantics (RFC 7396):
//   - field absent = don't change
//   - field null = clear
//   - field has value = set
type updateProjectDTO struct {
	Name         *string                   `json:"name,omitempty"`
	SystemPrompt optional.Optional[string] `json:"system_prompt"`
	Preferences  *preferencesDTO           `json:"preferences,omitempty"` // If provided, replaces preferences
}

// UpdateProject updates a project
// PATCH /api/projects/{id}
func (h *ProjectHandler) UpdateProject(w http.ResponseWriter, r *http.Request) {
	identifier, ok := PathParam(w, r, "id", "Project ID or slug")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	// Resolve identifier (UUID or slug) to project UUID
	projectID, err := h.resolver.ResolveProject(r.Context(), identifier, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	// Parse request into transport DTO
	var dto updateProjectDTO
	if err := httputil.ParseJSON(w, r, &dto); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Map transport DTO to service request
	req := &domaindocsys.UpdateProjectRequest{
		Name:         dto.Name,
		SystemPrompt: dto.SystemPrompt,
	}

	// Map preferences DTO to JSONMap if provided
	if dto.Preferences != nil {
		req.Preferences = domaindocsys.JSONMap{
			"disabled_tools": dto.Preferences.DisabledTools,
		}
	}

	project, err := h.projectService.UpdateProject(r.Context(), projectID, userID, req)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, project)
}

// DeleteProject soft-deletes a project and returns it with deleted_at timestamp
// DELETE /api/projects/{id}
func (h *ProjectHandler) DeleteProject(w http.ResponseWriter, r *http.Request) {
	identifier, ok := PathParam(w, r, "id", "Project ID or slug")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	// Resolve identifier (UUID or slug) to project UUID
	projectID, err := h.resolver.ResolveProject(r.Context(), identifier, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	project, err := h.projectService.DeleteProject(r.Context(), projectID, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, project)
}

// AddFavorite marks a project as favorite for the user
// POST /api/projects/{id}/favorite
func (h *ProjectHandler) AddFavorite(w http.ResponseWriter, r *http.Request) {
	identifier, ok := PathParam(w, r, "id", "Project ID or slug")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	// Resolve identifier (UUID or slug) to project UUID
	projectID, err := h.resolver.ResolveProject(r.Context(), identifier, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	if err := h.favoriteService.AddFavorite(r.Context(), userID, projectID); err != nil {
		handleError(w, err, h.config)
		return
	}

	// Return updated project with is_favorite=true
	project, err := h.projectService.GetProject(r.Context(), projectID, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, project)
}

// RemoveFavorite unmarks a project as favorite for the user
// DELETE /api/projects/{id}/favorite
func (h *ProjectHandler) RemoveFavorite(w http.ResponseWriter, r *http.Request) {
	identifier, ok := PathParam(w, r, "id", "Project ID or slug")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	// Resolve identifier (UUID or slug) to project UUID
	projectID, err := h.resolver.ResolveProject(r.Context(), identifier, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	if err := h.favoriteService.RemoveFavorite(r.Context(), userID, projectID); err != nil {
		handleError(w, err, h.config)
		return
	}

	// Return updated project with is_favorite=false
	project, err := h.projectService.GetProject(r.Context(), projectID, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, project)
}
