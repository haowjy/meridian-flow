package streaming

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	domaindocsys "meridian/internal/domain/docsystem"
	domainllm "meridian/internal/domain/llm"
	skill "meridian/internal/domain/skill"
)

// baseIdentityPrompt is the foundational identity prompt for Meridian.
// Tool descriptions are appended dynamically via ToolSection in PromptContext (OCP compliance).
const baseIdentityPrompt = `You are Meridian, an AI assistant with access to the user's document repository.`

// systemPromptResolver builds the final system prompt from project, thread, and skills.
// Implements domainllm.SystemPromptResolver interface.
//
// Skills metadata (names/descriptions) is NOT handled here — it flows through the tool
// system via skill_invoke's enriched ToolMetadata. This ensures skills metadata is
// naturally absent when a model doesn't support tools (SRP compliance).
type systemPromptResolver struct {
	projectRepo  domaindocsys.ProjectStore
	threadRepo   domainllm.ThreadStore
	skillService skill.ProjectSkillService
	logger       *slog.Logger
}

// NewSystemPromptResolver creates a new system prompt resolver.
func NewSystemPromptResolver(
	projectRepo domaindocsys.ProjectStore,
	threadRepo domainllm.ThreadStore,
	skillService skill.ProjectSkillService,
	logger *slog.Logger,
) domainllm.SystemPromptResolver {
	return &systemPromptResolver{
		projectRepo:  projectRepo,
		threadRepo:   threadRepo,
		skillService: skillService,
		logger:       logger,
	}
}

// Resolve builds the final system prompt using 7-position composition:
//
//  1. Base identity + tool section (always included; positions 1 & 2 combined)
//  2. Work context          (position 3 — empty when WorkContext is nil)
//  3. Project system prompt (position 4)
//  4. User-provided system prompt + thread.system_prompt (position 5)
//  5. Skills content        (position 6)
//  6. Persona body          (position 7 — empty when PersonaBody is nil)
//
// Positions 3 and 7 are extension points; nil fields produce no output, preserving
// existing behavior when those fields are not set.
//
// R1 guarantees that pc.ThreadID is always non-empty by the time Resolve is called
// (the thread is created before assemblePrompt runs).
func (r *systemPromptResolver) Resolve(ctx context.Context, pc domainllm.PromptContext) (string, error) {
	r.logger.Debug("resolving system prompt",
		"thread_id", pc.ThreadID,
		"project_id", pc.ProjectID,
		"user_id", pc.UserID,
		"user_system_provided", pc.UserSystem != nil,
		"selected_skills", pc.SelectedSkills,
		"tool_section_length", len(pc.ToolSection),
		"persona_body_provided", pc.PersonaBody != nil,
		"work_context_provided", pc.WorkContext != nil,
	)

	// Position 1 + 2: Base identity + tool section (OCP compliance — tools self-describe)
	var parts []string
	parts = append(parts, r.buildBasePrompt(pc.ToolSection))

	// Position 3: Work session context (nil → empty; no-op for now)
	if pc.WorkContext != nil {
		if s := r.buildWorkContextSection(pc.WorkContext); s != "" {
			parts = append(parts, s)
		}
	}

	// Load thread to get authoritative project ID and thread system prompt.
	thread, err := r.threadRepo.GetThread(ctx, pc.ThreadID, pc.UserID)
	if err != nil {
		return "", fmt.Errorf("load thread: %w", err)
	}

	// Position 4: Project system prompt (user-configured project instructions)
	project, err := r.projectRepo.GetByID(ctx, thread.ProjectID, pc.UserID)
	if err != nil {
		return "", fmt.Errorf("load project: %w", err)
	}
	if project.SystemPrompt != nil && *project.SystemPrompt != "" {
		r.logger.Debug("project system prompt found", "length", len(*project.SystemPrompt))
		parts = append(parts, *project.SystemPrompt)
	}

	// Position 5: Thread system prompt slot
	// a) User-provided system prompt from request_params.system
	if pc.UserSystem != nil && *pc.UserSystem != "" {
		r.logger.Debug("user system prompt found", "length", len(*pc.UserSystem))
		parts = append(parts, *pc.UserSystem)
	}
	// b) Thread's stored system_prompt column
	if thread.SystemPrompt != nil && *thread.SystemPrompt != "" {
		r.logger.Debug("thread system prompt found", "length", len(*thread.SystemPrompt))
		parts = append(parts, *thread.SystemPrompt)
	}

	// Position 6: Skills content
	if len(pc.SelectedSkills) > 0 {
		if skillsContent := r.loadSkills(ctx, pc.UserID, thread.ProjectID, pc.SelectedSkills); skillsContent != "" {
			parts = append(parts, skillsContent)
		}
	}

	// Position 7: Persona body (nil → empty; no-op for now)
	if pc.PersonaBody != nil && *pc.PersonaBody != "" {
		parts = append(parts, *pc.PersonaBody)
	}

	// Concatenate all parts (always has at least base prompt)
	result := strings.Join(parts, "\n\n")
	r.logger.Debug("system prompt resolved",
		"total_length", len(result),
		"parts_count", len(parts),
	)
	return result, nil
}

// loadSkills loads the content for each selected skill from DB via skill service.
// Returns empty string if no skills loaded successfully (header is only prepended when
// at least one skill loads, preventing the LLM from seeing a header with no content).
func (r *systemPromptResolver) loadSkills(
	ctx context.Context,
	userID string,
	projectID string,
	selectedSkills []string,
) string {
	r.logger.Debug("loading skills",
		"project_id", projectID,
		"skills_count", len(selectedSkills),
		"skills", selectedSkills,
	)

	var skillParts []string
	loadedCount := 0

	for _, skillName := range selectedSkills {
		content, err := r.skillService.LoadSkillContent(ctx, userID, projectID, skillName)
		if err != nil {
			r.logger.Warn("failed to load skill",
				"skill", skillName,
				"project_id", projectID,
				"error", err,
			)
			continue
		}

		r.logger.Debug("skill loaded successfully",
			"skill", skillName,
			"content_length", len(content),
		)
		loadedCount++

		// Format skill with path and code block wrapper
		skillPath := fmt.Sprintf(".meridian/skills/%s/SKILL.md", skillName)
		skillParts = append(skillParts, fmt.Sprintf("%s:\n```\n%s\n```", skillPath, content))
	}

	r.logger.Debug("skills loading complete",
		"requested", len(selectedSkills),
		"loaded", loadedCount,
		"failed", len(selectedSkills)-loadedCount,
	)

	if len(skillParts) == 0 {
		// All skills failed to load — omit the section entirely rather than
		// telling the LLM it has skills but listing none.
		return ""
	}

	// Prepend header only when at least one skill loaded successfully.
	header := "You have access to the following skills. View additional reference materials using tree(\".meridian/skills/{skill_name}\") and view(\".meridian/skills/{skill_name}/{file}\"):"
	parts := append([]string{header}, skillParts...)
	return strings.Join(parts, "\n\n")
}

// buildBasePrompt constructs the base system prompt with the tool section.
// toolSection is pre-built by ToolRegistry.BuildSystemPromptSection() for OCP compliance.
func (r *systemPromptResolver) buildBasePrompt(toolSection string) string {
	var sb strings.Builder
	sb.WriteString(baseIdentityPrompt)

	// Append tool section if provided (OCP compliance — generated from tool metadata)
	if toolSection != "" {
		sb.WriteString(toolSection)
	}

	return sb.String()
}

// buildWorkContextSection formats a WorkContext into a system prompt section (position 3).
// Returns empty string for nil input (guard — never called when WorkContext is nil).
func (r *systemPromptResolver) buildWorkContextSection(wc *domainllm.WorkContext) string {
	if wc == nil {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("# Active Work Session")
	if wc.WorkItem != "" {
		sb.WriteString("\nWork item: ")
		sb.WriteString(wc.WorkItem)
	}
	if wc.WorkDir != "" {
		sb.WriteString("\nWork directory: ")
		sb.WriteString(wc.WorkDir)
	}
	if wc.FSDir != "" {
		sb.WriteString("\nFilesystem directory: ")
		sb.WriteString(wc.FSDir)
	}
	if wc.ThreadID != "" {
		sb.WriteString("\nThread ID: ")
		sb.WriteString(wc.ThreadID)
	}
	return sb.String()
}
