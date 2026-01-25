package tools

import (
	"context"
	"fmt"
	"strings"

	skillSvc "meridian/internal/domain/services/skill"
)

// SkillInvokeTool implements the 'skill_invoke' tool for loading skill instructions on-demand.
// Claude sees skill metadata in system prompt, but full content is only loaded when invoked.
type SkillInvokeTool struct {
	projectID        string
	userID           string
	skillService     skillSvc.ProjectSkillService
	isUserInvocation bool // True if user explicitly invoked via slash command
	config           *ToolConfig
}

// NewSkillInvokeTool creates a new SkillInvokeTool instance.
func NewSkillInvokeTool(
	projectID string,
	userID string,
	skillService skillSvc.ProjectSkillService,
	isUserInvocation bool,
	config *ToolConfig,
) *SkillInvokeTool {
	if config == nil {
		config = DefaultToolConfig()
	}
	return &SkillInvokeTool{
		projectID:        projectID,
		userID:           userID,
		skillService:     skillService,
		isUserInvocation: isUserInvocation,
		config:           config,
	}
}

// Execute implements ToolExecutor interface.
// Input parameters:
//   - skill_name (string, required): Name of the skill to invoke (e.g., "writing-coach")
//   - arguments (string, optional): Arguments to pass to the skill (replaces $ARGUMENTS)
//
// Returns:
//   - Skill content with $ARGUMENTS substituted
func (t *SkillInvokeTool) Execute(ctx context.Context, input map[string]any) (any, error) {
	// Extract and validate skill_name
	skillName, ok := input["skill_name"].(string)
	if !ok || skillName == "" {
		return ErrorResult(ErrMissingParam, "Missing required parameter", map[string]any{"param": "skill_name"}), nil
	}
	skillName = strings.TrimSpace(skillName)

	// Extract optional arguments
	arguments := ""
	if argsVal, exists := input["arguments"]; exists {
		if args, ok := argsVal.(string); ok {
			arguments = strings.TrimSpace(args)
		}
	}

	// Get skill metadata first to check invocation permissions
	skill, err := t.skillService.GetSkillByName(ctx, t.userID, t.projectID, skillName)
	if err != nil {
		return ErrorResult(ErrNotFound, fmt.Sprintf("Skill '%s' not found", skillName), map[string]any{
			"skill_name": skillName,
		}), nil
	}

	// Check invocation permissions
	meta := skill.GetMetadata()
	if meta.DisableModelInvocation && !t.isUserInvocation {
		return ErrorResult(ErrInvalidInput, "This skill can only be invoked manually by the user", map[string]any{
			"skill_name":  skillName,
			"reason":      "disable_model_invocation is true",
			"suggestion":  "User can invoke with /" + skillName,
		}), nil
	}

	// Load content from SKILL.md
	content, err := t.skillService.LoadSkillContent(ctx, t.userID, t.projectID, skillName)
	if err != nil {
		return nil, fmt.Errorf("failed to load skill content: %w", err)
	}

	// Replace $ARGUMENTS placeholder if arguments provided
	if arguments != "" {
		content = strings.ReplaceAll(content, "$ARGUMENTS", arguments)
	}

	// Return the skill content as a formatted response
	return map[string]any{
		"type":         "skill",
		"skill_name":   skill.Name,
		"display_name": skill.DisplayName,
		"content":      content,
	}, nil
}

// SkillListTool implements the 'skill_list' tool for listing available skills.
type SkillListTool struct {
	projectID    string
	userID       string
	skillService skillSvc.ProjectSkillService
	config       *ToolConfig
}

// NewSkillListTool creates a new SkillListTool instance.
func NewSkillListTool(
	projectID string,
	userID string,
	skillService skillSvc.ProjectSkillService,
	config *ToolConfig,
) *SkillListTool {
	if config == nil {
		config = DefaultToolConfig()
	}
	return &SkillListTool{
		projectID:    projectID,
		userID:       userID,
		skillService: skillService,
		config:       config,
	}
}

// Execute implements ToolExecutor interface.
// Returns a list of available skills for this project.
func (t *SkillListTool) Execute(ctx context.Context, input map[string]any) (any, error) {
	skills, err := t.skillService.ListSkills(ctx, t.userID, t.projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list skills: %w", err)
	}

	// Format skill list
	skillList := make([]map[string]any, 0, len(skills))
	for _, skill := range skills {
		// Skip skills that can't be model-invoked
		meta := skill.GetMetadata()
		if meta.DisableModelInvocation {
			continue
		}
		skillList = append(skillList, map[string]any{
			"name":         skill.Name,
			"display_name": skill.DisplayName,
			"description":  skill.Description,
		})
	}

	return map[string]any{
		"type":   "skill_list",
		"skills": skillList,
		"count":  len(skillList),
	}, nil
}
