package handler

import (
	"log/slog"
	"net/http"
	"net/url"

	"meridian/internal/config"
	authdomain "meridian/internal/domain/auth"
	domainagents "meridian/internal/domain/agents"
	"meridian/internal/httputil"
)

// AgentImportHandler handles git-based agent bundle import requests.
//
// Route: POST /api/projects/{id}/agents/import-git
//
// The handler is responsible for:
//   1. Parsing and validating the project ID path parameter.
//   2. Checking that the authenticated user can access the project.
//   3. Parsing the request body to extract the repository URL.
//   4. Delegating to AgentImportService which performs URL validation, cloning,
//      file validation, and the atomic document write.
type AgentImportHandler struct {
	importSvc  domainagents.AgentImportService
	authorizer authdomain.ResourceAuthorizer
	logger     *slog.Logger
	config     *config.Config
}

// NewAgentImportHandler creates an AgentImportHandler.
func NewAgentImportHandler(
	importSvc domainagents.AgentImportService,
	authorizer authdomain.ResourceAuthorizer,
	logger *slog.Logger,
	cfg *config.Config,
) *AgentImportHandler {
	return &AgentImportHandler{
		importSvc:  importSvc,
		authorizer: authorizer,
		logger:     logger,
		config:     cfg,
	}
}

// importGitRequest is the JSON body for the import-git endpoint.
type importGitRequest struct {
	URL string `json:"url"`
}

// importGitResponse is the JSON body returned on success.
type importGitResponse struct {
	Status string `json:"status"`
}

// ImportFromGit handles POST /api/projects/{id}/agents/import-git.
//
// Request body:
//
//	{"url": "https://github.com/user/repo"}
//
// Success response (200):
//
//	{"status": "ok"}
//
// Error responses follow the standard DomainError shape:
//   - 400  invalid project ID or missing URL
//   - 401  unauthenticated
//   - 403  user does not have access to the project
//   - 422  import validation failed (SSRF guard, binary file, bad frontmatter, …)
//   - 500  unexpected internal error
func (h *AgentImportHandler) ImportFromGit(w http.ResponseWriter, r *http.Request) {
	projectIDStr, ok := PathParam(w, r, "id", "project ID")
	if !ok {
		return
	}

	projectID, err := parseUUID(projectIDStr)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid project ID: must be a UUID")
		return
	}

	var body importGitRequest
	if err := httputil.ParseJSON(w, r, &body); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if body.URL == "" {
		httputil.RespondError(w, http.StatusBadRequest, "url is required")
		return
	}

	userID := httputil.GetUserID(r)
	if err := h.authorizer.CanAccessProject(r.Context(), userID, projectIDStr); err != nil {
		handleError(w, err, h.config)
		return
	}

	// Sanitize the URL before any logging to strip embedded credentials
	// (e.g. https://user:token@github.com/...).
	sanitizedURL := sanitizeImportURL(body.URL)

	if err := h.importSvc.ImportFromGit(r.Context(), projectID, body.URL); err != nil {
		h.logger.Warn("agent import failed",
			"project_id", projectIDStr,
			"url", sanitizedURL,
			"error", err,
		)
		handleError(w, err, h.config)
		return
	}

	h.logger.Info("agent import succeeded",
		"project_id", projectIDStr,
		"url", sanitizedURL,
	)

	httputil.RespondJSON(w, http.StatusOK, importGitResponse{Status: "ok"})
}

// sanitizeImportURL strips userinfo (credentials) from rawURL before logging.
// Prevents https://user:token@host/... from appearing in log output.
func sanitizeImportURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "[unparseable URL]"
	}
	u.User = nil
	return u.String()
}
