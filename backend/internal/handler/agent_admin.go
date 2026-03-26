package handler

import (
	"log/slog"
	"net/http"

	"github.com/google/uuid"

	"meridian/internal/config"
	domainagents "meridian/internal/domain/agents"
	"meridian/internal/httputil"
)

// AgentAdminHandler handles admin operations for the .agents/ namespace.
type AgentAdminHandler struct {
	backfillSvc domainagents.BackfillService
	logger      *slog.Logger
	config      *config.Config
}

// NewAgentAdminHandler creates a new AgentAdminHandler.
func NewAgentAdminHandler(
	backfillSvc domainagents.BackfillService,
	logger *slog.Logger,
	cfg *config.Config,
) *AgentAdminHandler {
	return &AgentAdminHandler{
		backfillSvc: backfillSvc,
		logger:      logger,
		config:      cfg,
	}
}

// BackfillSkills migrates legacy project_skills rows to .agents/skills/<slug>/SKILL.md.
// POST /api/projects/{id}/agents/backfill
//
// Idempotent: skills that already have a SKILL.md file are skipped without modification.
// Returns HTTP 200 on full success, HTTP 500 if any skill failed to migrate.
func (h *AgentAdminHandler) BackfillSkills(w http.ResponseWriter, r *http.Request) {
	projectIDStr, ok := PathParam(w, r, "id", "Project ID")
	if !ok {
		return
	}

	projectID, err := uuid.Parse(projectIDStr)
	if err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid project ID: must be a UUID")
		return
	}

	if err := h.backfillSvc.BackfillSkills(r.Context(), projectID); err != nil {
		h.logger.Error("backfill skills failed",
			"project_id", projectIDStr,
			"error", err,
		)
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
	})
}
