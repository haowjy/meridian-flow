package handler

import (
	"log/slog"
	"net/http"

	"meridian/internal/config"
	docsysSvc "meridian/internal/domain/services/docsystem"
	identifierSvc "meridian/internal/domain/services/identifier"
	"meridian/internal/httputil"
)

// TreeHandler handles HTTP requests for tree operations
type TreeHandler struct {
	treeService docsysSvc.TreeService
	resolver    identifierSvc.Resolver
	logger      *slog.Logger
	config      *config.Config
}

// NewTreeHandler creates a new tree handler
func NewTreeHandler(treeService docsysSvc.TreeService, resolver identifierSvc.Resolver, logger *slog.Logger, cfg *config.Config) *TreeHandler {
	return &TreeHandler{
		treeService: treeService,
		resolver:    resolver,
		logger:      logger,
		config:      cfg,
	}
}

// GetTree returns the nested folder/document tree for a project
// GET /api/projects/{id}/tree
// Query params:
//   - include_hidden: "true" to include hidden folders (default: false)
func (h *TreeHandler) GetTree(w http.ResponseWriter, r *http.Request) {
	// Get project identifier from URL path (can be UUID or slug)
	identifier := r.PathValue("id")
	if identifier == "" {
		httputil.RespondError(w, http.StatusBadRequest, "Project ID or slug is required")
		return
	}

	// Get userID from context (set by auth middleware)
	userID := httputil.GetUserID(r)

	// Parse include_hidden query param (default: false)
	includeHidden := r.URL.Query().Get("include_hidden") == "true"

	// Resolve identifier (UUID or slug) to project UUID
	projectID, err := h.resolver.ResolveProject(r.Context(), identifier, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	// Build the tree with options
	opts := docsysSvc.TreeOptions{
		IncludeHidden: includeHidden,
	}
	tree, err := h.treeService.GetProjectTreeWithOptions(r.Context(), userID, projectID, opts)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, toTreeResponseDTO(tree))
}
