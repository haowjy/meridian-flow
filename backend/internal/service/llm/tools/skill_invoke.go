package tools

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	domainagents "meridian/internal/domain/agents"
)

// SkillInvokeToolMetadata returns metadata for the skill_invoke tool.
// This enables OCP compliance - tool self-describes for system prompt generation.
func SkillInvokeToolMetadata() *ToolMetadata {
	return &ToolMetadata{
		Name:        "skill_invoke",
		Description: "Load skill instructions on-demand (when skills are available)",
		Guideline:   "Use skill_invoke when a task matches an available skill",
	}
}

// BuildSkillInvokeGuideline enriches the skill_invoke guideline with available skills.
// Called by the builder to compose runtime context into static metadata.
// Filters out skills where ModelInvocable is explicitly false (nil means true).
func BuildSkillInvokeGuideline(skills []domainagents.RuntimeSkill) string {
	base := "Use skill_invoke when a task matches an available skill"

	if len(skills) == 0 {
		return base
	}

	// Filter to model-invocable skills only (nil ModelInvocable → default true)
	var lines []string
	for _, skill := range skills {
		if !domainagents.BoolDefaultTrue(skill.ModelInvocable) {
			continue
		}
		lines = append(lines, fmt.Sprintf("- **/%s**: %s", skill.Name, skill.Description))
	}

	if len(lines) == 0 {
		return base
	}

	return base + "\n\nAvailable skills:\n" + strings.Join(lines, "\n")
}

// SkillListToolMetadata returns metadata for the skill_list tool.
// This enables OCP compliance - tool self-describes for system prompt generation.
func SkillListToolMetadata() *ToolMetadata {
	return &ToolMetadata{
		Name:        "skill_list",
		Description: "List available skills for this project",
		Guideline:   "", // No specific guideline needed
	}
}

// SkillInvokeTool implements the 'skill_invoke' tool for loading skill instructions on-demand.
// Claude sees skill metadata in system prompt, but full content is only loaded when invoked.
// Resolution is file-backed via SkillResolver (.agents/skills/<slug>/SKILL.md).
type SkillInvokeTool struct {
	projectID        string
	skillResolver    domainagents.SkillResolver
	isUserInvocation bool // True if user explicitly invoked via slash command
	config           *ToolConfig
}

// NewSkillInvokeTool creates a new SkillInvokeTool instance.
func NewSkillInvokeTool(
	projectID string,
	skillResolver domainagents.SkillResolver,
	isUserInvocation bool,
	config *ToolConfig,
) *SkillInvokeTool {
	if config == nil {
		config = DefaultToolConfig()
	}
	return &SkillInvokeTool{
		projectID:        projectID,
		skillResolver:    skillResolver,
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

	// Parse projectID for the resolver.
	projectUUID, err := uuid.Parse(t.projectID)
	if err != nil {
		return nil, fmt.Errorf("skill_invoke: invalid project ID %q: %w", t.projectID, err)
	}

	// Resolve skill from .agents/skills/<slug>/SKILL.md.
	skill, err := t.skillResolver.Resolve(ctx, projectUUID, skillName)
	if err != nil {
		return ErrorResult(ErrNotFound, fmt.Sprintf("skill '%s' not found", skillName), map[string]any{
			"skill_name": skillName,
		}), nil
	}

	// Check invocation permissions (nil ModelInvocable → default true).
	if !domainagents.BoolDefaultTrue(skill.ModelInvocable) && !t.isUserInvocation {
		return ErrorResult(ErrInvalidInput, "This skill can only be invoked manually by the user", map[string]any{
			"skill_name": skillName,
			"reason":     "model-invocable is false",
			"suggestion": "User can invoke with /" + skillName,
		}), nil
	}

	// Content is the SKILL.md body (frontmatter already stripped by resolver).
	content := skill.Content
	if arguments != "" {
		content = strings.ReplaceAll(content, "$ARGUMENTS", arguments)
	}

	return map[string]any{
		"type":       "skill",
		"skill_name": skill.Name,
		"content":    content,
	}, nil
}

// SkillListTool implements the 'skill_list' tool for listing available skills.
// Resolution is file-backed via SkillResolver (.agents/skills/).
type SkillListTool struct {
	projectID     string
	skillResolver domainagents.SkillResolver
	config        *ToolConfig
}

// NewSkillListTool creates a new SkillListTool instance.
func NewSkillListTool(
	projectID string,
	skillResolver domainagents.SkillResolver,
	config *ToolConfig,
) *SkillListTool {
	if config == nil {
		config = DefaultToolConfig()
	}
	return &SkillListTool{
		projectID:     projectID,
		skillResolver: skillResolver,
		config:        config,
	}
}

// Execute implements ToolExecutor interface.
// Returns a list of available skills for this project.
func (t *SkillListTool) Execute(ctx context.Context, input map[string]any) (any, error) {
	projectUUID, err := uuid.Parse(t.projectID)
	if err != nil {
		return nil, fmt.Errorf("skill_list: invalid project ID %q: %w", t.projectID, err)
	}

	skills, _, err := t.skillResolver.List(ctx, projectUUID)
	if err != nil {
		return nil, fmt.Errorf("failed to list skills: %w", err)
	}

	// Format skill list — only include model-invocable skills (nil → default true).
	skillList := make([]map[string]any, 0, len(skills))
	for _, skill := range skills {
		if !domainagents.BoolDefaultTrue(skill.ModelInvocable) {
			continue
		}
		skillList = append(skillList, map[string]any{
			"name":        skill.Name,
			"description": skill.Description,
		})
	}

	return map[string]any{
		"type":   "skill_list",
		"skills": skillList,
		"count":  len(skillList),
	}, nil
}
