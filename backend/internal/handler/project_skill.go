package handler

import (
	"log/slog"
	"net/http"

	"meridian/internal/config"
	skill "meridian/internal/domain/skill"
	"meridian/internal/httputil"
)

// ProjectSkillHandler handles skill HTTP requests for a project
type ProjectSkillHandler struct {
	skillService skill.ProjectSkillService
	logger       *slog.Logger
	config       *config.Config
}

// NewProjectSkillHandler creates a new project skill handler
func NewProjectSkillHandler(skillService skill.ProjectSkillService, logger *slog.Logger, cfg *config.Config) *ProjectSkillHandler {
	return &ProjectSkillHandler{
		skillService: skillService,
		logger:       logger,
		config:       cfg,
	}
}

// CreateSkill creates a new skill for a project
// POST /api/projects/{projectId}/skills
func (h *ProjectSkillHandler) CreateSkill(w http.ResponseWriter, r *http.Request) {
	projectID, ok := PathParam(w, r, "projectId", "Project ID")
	if !ok {
		return
	}

	var req CreateSkillRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate required fields
	if req.Name == "" {
		httputil.RespondError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.Description == "" {
		httputil.RespondError(w, http.StatusBadRequest, "description is required")
		return
	}

	userID := httputil.GetUserID(r)

	// Apply defaults for optional boolean fields
	disableModelInvocation := false // Default: model can invoke
	if req.DisableModelInvocation != nil {
		disableModelInvocation = *req.DisableModelInvocation
	}
	userInvocable := true // Default: user can invoke via slash command
	if req.UserInvocable != nil {
		userInvocable = *req.UserInvocable
	}

	// Convert to service request
	svcReq := skill.CreateSkillRequest{
		ProjectID:              projectID,
		Name:                   req.Name,
		Description:            req.Description,
		Content:                req.Content,
		DisableModelInvocation: disableModelInvocation,
		UserInvocable:          userInvocable,
	}

	skill, err := h.skillService.CreateSkill(r.Context(), userID, svcReq)
	if err != nil {
		h.logger.Error("failed to create skill",
			"project_id", projectID,
			"user_id", userID,
			"skill_name", req.Name,
			"error", err,
		)
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusCreated, toSkillResponse(skill))
}

// ListSkills lists all skills for a project
// GET /api/projects/{projectId}/skills
func (h *ProjectSkillHandler) ListSkills(w http.ResponseWriter, r *http.Request) {
	projectID, ok := PathParam(w, r, "projectId", "Project ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	skills, err := h.skillService.ListSkills(r.Context(), userID, projectID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, toSkillListResponse(skills))
}

// GetSkill retrieves a skill by ID with content
// GET /api/projects/{projectId}/skills/{skillId}
func (h *ProjectSkillHandler) GetSkill(w http.ResponseWriter, r *http.Request) {
	projectID, ok := PathParam(w, r, "projectId", "Project ID")
	if !ok {
		return
	}
	skillID, ok := PathParam(w, r, "skillId", "Skill ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	skill, err := h.skillService.GetSkill(r.Context(), userID, projectID, skillID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, toSkillWithContentResponse(skill))
}

// UpdateSkill updates a skill's metadata and/or content
// PUT /api/projects/{projectId}/skills/{skillId}
func (h *ProjectSkillHandler) UpdateSkill(w http.ResponseWriter, r *http.Request) {
	projectID, ok := PathParam(w, r, "projectId", "Project ID")
	if !ok {
		return
	}
	skillID, ok := PathParam(w, r, "skillId", "Skill ID")
	if !ok {
		return
	}

	var req UpdateSkillRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	userID := httputil.GetUserID(r)

	// Convert to service request
	svcReq := skill.UpdateSkillRequest{
		Name:                   req.Name,
		Description:            req.Description,
		Content:                req.Content,
		Enabled:                req.Enabled,
		DisableModelInvocation: req.DisableModelInvocation,
		UserInvocable:          req.UserInvocable,
	}

	skill, err := h.skillService.UpdateSkill(r.Context(), userID, projectID, skillID, svcReq)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, toSkillResponse(skill))
}

// ReorderSkills updates the positions of skills
// PUT /api/projects/{projectId}/skills/reorder
func (h *ProjectSkillHandler) ReorderSkills(w http.ResponseWriter, r *http.Request) {
	projectID, ok := PathParam(w, r, "projectId", "Project ID")
	if !ok {
		return
	}

	var req ReorderSkillsRequest
	if err := httputil.ParseJSON(w, r, &req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if len(req.SkillIDs) == 0 {
		httputil.RespondError(w, http.StatusBadRequest, "skill_ids is required")
		return
	}

	userID := httputil.GetUserID(r)

	if err := h.skillService.ReorderSkills(r.Context(), userID, projectID, req.SkillIDs); err != nil {
		handleError(w, err, h.config)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// DeleteSkill soft-deletes a skill
// DELETE /api/projects/{projectId}/skills/{skillId}
func (h *ProjectSkillHandler) DeleteSkill(w http.ResponseWriter, r *http.Request) {
	projectID, ok := PathParam(w, r, "projectId", "Project ID")
	if !ok {
		return
	}
	skillID, ok := PathParam(w, r, "skillId", "Skill ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	deletedSkill, err := h.skillService.DeleteSkill(r.Context(), userID, projectID, skillID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	httputil.RespondJSON(w, http.StatusOK, toSkillResponse(deletedSkill))
}
