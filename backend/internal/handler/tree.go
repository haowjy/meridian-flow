package handler

import (
	"log/slog"
	"net/http"

	docsysSvc "meridian/internal/domain/services/docsystem"
	"meridian/internal/httputil"
)

// TreeHandler handles HTTP requests for tree operations
type TreeHandler struct {
	treeService docsysSvc.TreeService
	logger      *slog.Logger
}

// NewTreeHandler creates a new tree handler
func NewTreeHandler(treeService docsysSvc.TreeService, logger *slog.Logger) *TreeHandler {
	return &TreeHandler{
		treeService: treeService,
		logger:      logger,
	}
}

// GetTree returns the nested folder/document tree for a project
func (h *TreeHandler) GetTree(w http.ResponseWriter, r *http.Request) {
	// Get project ID from URL path
	projectID := r.PathValue("id")
	if projectID == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Project ID is required")
		return
	}

	// Build the tree
	tree, err := h.treeService.GetProjectTree(r.Context(), projectID)
	if err != nil {
		handleError(w, err)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, tree)
}
