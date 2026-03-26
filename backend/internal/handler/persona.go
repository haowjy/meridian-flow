package handler

// persona.go — Read-only handler for the persona (agent) catalog.
//
// Route: GET /api/projects/{id}/agents
//
// Returns all user-invocable personas from .agents/agents/*.md alongside any
// validation issues found during enumeration. Invalid entries are not hidden
// from the response — they are surfaced in the "issues" list so the frontend
// can display configuration warnings.

import (
	"log/slog"
	"net/http"

	"meridian/internal/config"
	authdomain "meridian/internal/domain/auth"
	domainagents "meridian/internal/domain/agents"
	"meridian/internal/httputil"
)

// PersonaHandler handles persona (agent) catalog HTTP requests.
type PersonaHandler struct {
	personaCatalog domainagents.PersonaCatalog
	authorizer     authdomain.ResourceAuthorizer
	logger         *slog.Logger
	config         *config.Config
}

// NewPersonaHandler creates a PersonaHandler.
func NewPersonaHandler(
	catalog domainagents.PersonaCatalog,
	authorizer authdomain.ResourceAuthorizer,
	logger *slog.Logger,
	cfg *config.Config,
) *PersonaHandler {
	return &PersonaHandler{
		personaCatalog: catalog,
		authorizer:     authorizer,
		logger:         logger,
		config:         cfg,
	}
}

// listAgentsResponse is the JSON shape for GET /api/projects/{id}/agents.
type listAgentsResponse struct {
	// Agents contains all user-invocable personas that parsed successfully.
	Agents []domainagents.Persona `json:"agents"`
	// Issues describes files that failed to parse or have configuration problems.
	// An entry in Issues does NOT imply the persona is absent from Agents —
	// model-availability issues are reported here while the persona is still listed.
	Issues []domainagents.ValidationIssue `json:"issues"`
}

// ListAgents handles GET /api/projects/{id}/agents.
//
// Returns all user-invocable personas (UserInvocable=true or unset) for the
// project, plus any validation issues found during catalog enumeration.
//
// Response shape:
//
//	{
//	  "agents": [ { "slug": "writing-coach", "name": "Writing Coach", ... }, ... ],
//	  "issues": [ { "path": ".agents/agents/broken.md", "message": "..." }, ... ]
//	}
//
// HTTP 200 even when "agents" is empty (no .agents/agents/ folder yet).
// HTTP 403 when the caller does not have access to the project.
func (h *PersonaHandler) ListAgents(w http.ResponseWriter, r *http.Request) {
	projectIDStr, ok := PathParam(w, r, "id", "project ID")
	if !ok {
		return
	}

	projectID, err := parseUUID(projectIDStr)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid project ID: must be a UUID")
		return
	}

	userID := httputil.GetUserID(r)
	if err := h.authorizer.CanAccessProject(r.Context(), userID, projectIDStr); err != nil {
		handleError(w, err, h.config)
		return
	}

	personas, issues, err := h.personaCatalog.ListUserPersonas(r.Context(), projectID)
	if err != nil {
		h.logger.Error("failed to list personas",
			"project_id", projectIDStr,
			"error", err,
		)
		handleError(w, err, h.config)
		return
	}

	// Normalize nil slices to empty slices for consistent JSON serialization.
	if personas == nil {
		personas = []domainagents.Persona{}
	}
	if issues == nil {
		issues = []domainagents.ValidationIssue{}
	}

	httputil.RespondJSON(w, http.StatusOK, listAgentsResponse{
		Agents: personas,
		Issues: issues,
	})
}
