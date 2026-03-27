package handler

import (
	"log/slog"
	"net/http"

	"meridian/internal/config"
	domainwi "meridian/internal/domain/workitem"
	"meridian/internal/httputil"
)

// WorkItemHandler handles REST endpoints for work items.
// Routes are scoped to /api/projects/{id}/work-items to align with the
// project-centric resource hierarchy.
type WorkItemHandler struct {
	svc    domainwi.Service
	logger *slog.Logger
	config *config.Config
}

// NewWorkItemHandler creates a new WorkItemHandler.
func NewWorkItemHandler(svc domainwi.Service, logger *slog.Logger, cfg *config.Config) *WorkItemHandler {
	return &WorkItemHandler{
		svc:    svc,
		logger: logger,
		config: cfg,
	}
}

// ---------------------------------------------------------------------------
// Request / Response DTOs
// ---------------------------------------------------------------------------

// createWorkItemRequest is the JSON body for POST /work-items.
type createWorkItemRequest struct {
	Name        string                 `json:"name"`
	Description *string                `json:"description,omitempty"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
	IsEphemeral bool                   `json:"is_ephemeral"`
}

// updateWorkItemRequest is the JSON body for PUT /work-items/{slug}.
type updateWorkItemRequest struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
	// ClearDescription, when true, explicitly sets description to null.
	ClearDescription bool                   `json:"clear_description"`
	Metadata         map[string]interface{} `json:"metadata,omitempty"`
}

// workItemResponse is the JSON representation of a work item returned to clients.
// Maps 1-1 with the domain type — any future evolution should add fields here
// rather than exposing the domain type directly.
type workItemResponse struct {
	ID          string                 `json:"id"`
	ProjectID   string                 `json:"project_id"`
	UserID      string                 `json:"user_id"`
	Name        string                 `json:"name"`
	Slug        string                 `json:"slug"`
	Description *string                `json:"description,omitempty"`
	Status      string                 `json:"status"`
	IsEphemeral bool                   `json:"is_ephemeral"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
	CreatedAt   string                 `json:"created_at"`
	UpdatedAt   string                 `json:"updated_at"`
	DeletedAt   *string                `json:"deleted_at,omitempty"`
}

// listWorkItemsResponse wraps a paginated list of work items.
type listWorkItemsResponse struct {
	Items  []workItemResponse `json:"items"`
	Total  int                `json:"total"`
	Offset int                `json:"offset"`
	Limit  int                `json:"limit"`
}

func toWorkItemResponse(wi *domainwi.WorkItem) workItemResponse {
	resp := workItemResponse{
		ID:          wi.ID,
		ProjectID:   wi.ProjectID,
		UserID:      wi.UserID,
		Name:        wi.Name,
		Slug:        wi.Slug,
		Description: wi.Description,
		Status:      string(wi.Status),
		IsEphemeral: wi.IsEphemeral,
		Metadata:    wi.Metadata,
		CreatedAt:   wi.CreatedAt.Format("2006-01-02T15:04:05Z"),
		UpdatedAt:   wi.UpdatedAt.Format("2006-01-02T15:04:05Z"),
	}
	if wi.DeletedAt != nil {
		s := wi.DeletedAt.Format("2006-01-02T15:04:05Z")
		resp.DeletedAt = &s
	}
	return resp
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// CreateWorkItem creates a new work item for the project.
// POST /api/projects/{id}/work-items
func (h *WorkItemHandler) CreateWorkItem(w http.ResponseWriter, r *http.Request) {
	projectID, ok := ParseUUID(w, r, "id", "Project ID")
	if !ok {
		return
	}
	userID := httputil.GetUserID(r)

	var req createWorkItemRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Name == "" {
		httputil.RespondError(w, http.StatusBadRequest, "name is required")
		return
	}

	wi, err := h.svc.Create(r.Context(), projectID, userID, &domainwi.CreateRequest{
		Name:        req.Name,
		Description: req.Description,
		Metadata:    req.Metadata,
		IsEphemeral: req.IsEphemeral,
	})
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, toWorkItemResponse(wi))
}

// ListWorkItems returns a paginated list of work items for the project.
// GET /api/projects/{id}/work-items?offset=0&limit=20
func (h *WorkItemHandler) ListWorkItems(w http.ResponseWriter, r *http.Request) {
	projectID, ok := ParseUUID(w, r, "id", "Project ID")
	if !ok {
		return
	}
	userID := httputil.GetUserID(r)

	offset := QueryInt(r, "offset", 0, 0, 1<<31-1)
	limit := QueryInt(r, "limit", 20, 1, 100)
	status := r.URL.Query().Get("status")

	items, total, err := h.svc.List(r.Context(), projectID, userID, status, offset, limit)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	resp := listWorkItemsResponse{
		Items:  make([]workItemResponse, len(items)),
		Total:  total,
		Offset: offset,
		Limit:  limit,
	}
	for i := range items {
		resp.Items[i] = toWorkItemResponse(&items[i])
	}

	httputil.RespondJSON(w, http.StatusOK, resp)
}

// GetWorkItem returns a single work item by slug.
// GET /api/projects/{id}/work-items/{slug}
func (h *WorkItemHandler) GetWorkItem(w http.ResponseWriter, r *http.Request) {
	projectID, ok := ParseUUID(w, r, "id", "Project ID")
	if !ok {
		return
	}
	slug, ok := PathParam(w, r, "slug", "Work Item Slug")
	if !ok {
		return
	}
	userID := httputil.GetUserID(r)

	wi, err := h.svc.GetBySlug(r.Context(), projectID, userID, slug)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, toWorkItemResponse(wi))
}

// UpdateWorkItem applies a partial update to a work item.
// PUT /api/projects/{id}/work-items/{slug}
func (h *WorkItemHandler) UpdateWorkItem(w http.ResponseWriter, r *http.Request) {
	projectID, ok := ParseUUID(w, r, "id", "Project ID")
	if !ok {
		return
	}
	slug, ok := PathParam(w, r, "slug", "Work Item Slug")
	if !ok {
		return
	}
	userID := httputil.GetUserID(r)

	var req updateWorkItemRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	wi, err := h.svc.UpdateBySlug(r.Context(), projectID, userID, slug, &domainwi.UpdateRequest{
		Name:        req.Name,
		Description: req.Description,
		ClearDesc:   req.ClearDescription,
		Metadata:    req.Metadata,
	})
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, toWorkItemResponse(wi))
}

// CompleteWorkItem transitions a work item to done.
// POST /api/projects/{id}/work-items/{slug}/complete
func (h *WorkItemHandler) CompleteWorkItem(w http.ResponseWriter, r *http.Request) {
	projectID, ok := ParseUUID(w, r, "id", "Project ID")
	if !ok {
		return
	}
	slug, ok := PathParam(w, r, "slug", "Work Item Slug")
	if !ok {
		return
	}
	userID := httputil.GetUserID(r)

	wi, err := h.svc.CompleteBySlug(r.Context(), projectID, userID, slug)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, toWorkItemResponse(wi))
}

// ReopenWorkItem transitions a work item from done back to active.
// POST /api/projects/{id}/work-items/{slug}/reopen
func (h *WorkItemHandler) ReopenWorkItem(w http.ResponseWriter, r *http.Request) {
	projectID, ok := ParseUUID(w, r, "id", "Project ID")
	if !ok {
		return
	}
	slug, ok := PathParam(w, r, "slug", "Work Item Slug")
	if !ok {
		return
	}
	userID := httputil.GetUserID(r)

	wi, err := h.svc.ReopenBySlug(r.Context(), projectID, userID, slug)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, toWorkItemResponse(wi))
}

// DeleteWorkItem soft-deletes a work item.
// DELETE /api/projects/{id}/work-items/{slug}
func (h *WorkItemHandler) DeleteWorkItem(w http.ResponseWriter, r *http.Request) {
	projectID, ok := ParseUUID(w, r, "id", "Project ID")
	if !ok {
		return
	}
	slug, ok := PathParam(w, r, "slug", "Work Item Slug")
	if !ok {
		return
	}
	userID := httputil.GetUserID(r)

	if err := h.svc.DeleteBySlug(r.Context(), projectID, userID, slug); err != nil {
		handleError(w, err, h.config)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
