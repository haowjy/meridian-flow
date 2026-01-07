package handler

import (
	"log/slog"
	"net/http"

	docsysSvc "meridian/internal/domain/services/docsystem"
	identifierSvc "meridian/internal/domain/services/identifier"
	"meridian/internal/httputil"
)

// TreeHandler handles HTTP requests for tree operations
type TreeHandler struct {
	treeService docsysSvc.TreeService
	resolver    identifierSvc.Resolver
	logger      *slog.Logger
}

// NewTreeHandler creates a new tree handler
func NewTreeHandler(treeService docsysSvc.TreeService, resolver identifierSvc.Resolver, logger *slog.Logger) *TreeHandler {
	return &TreeHandler{
		treeService: treeService,
		resolver:    resolver,
		logger:      logger,
	}
}

// GetTree returns the nested folder/document tree for a project
// GET /api/projects/{id}/tree
func (h *TreeHandler) GetTree(w http.ResponseWriter, r *http.Request) {
	// Get project identifier from URL path (can be UUID or slug)
	identifier := r.PathValue("id")
	if identifier == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Project ID or slug is required")
		return
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)

	// Resolve identifier (UUID or slug) to project UUID
	projectID, err := h.resolver.ResolveProject(r.Context(), identifier, userID)
	if err != nil {
		handleError(w, err)
		return
	}

	// Build the tree
	tree, err := h.treeService.GetProjectTree(r.Context(), userID, projectID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, toTreeResponseDTO(tree))
}
