package streaming

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	docsysModels "meridian/internal/domain/models/docsystem"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
	llmRepo "meridian/internal/domain/repositories/llm"
	llmSvc "meridian/internal/domain/services/llm"
)

// systemPromptResolver builds the final system prompt from project, thread, and skills
// Implements llmSvc.SystemPromptResolver interface
type systemPromptResolver struct {
	projectRepo  docsysRepo.ProjectRepository
	threadRepo   llmRepo.ThreadRepository
	documentRepo docsysRepo.DocumentRepository
	logger       *slog.Logger
}

// NewSystemPromptResolver creates a new system prompt resolver
func NewSystemPromptResolver(
	projectRepo docsysRepo.ProjectRepository,
	threadRepo llmRepo.ThreadRepository,
	documentRepo docsysRepo.DocumentRepository,
	logger *slog.Logger,
) llmSvc.SystemPromptResolver {
	return &systemPromptResolver{
		projectRepo:  projectRepo,
		threadRepo:   threadRepo,
		documentRepo: documentRepo,
		logger:       logger,
	}
}

// Resolve builds the final system prompt by concatenating:
// 1. user-provided system prompt (from request_params.system)
// 2. project.system_prompt
// 3. thread.system_prompt
// 4. Content of each skill's SKILL.md file from .skills/{skill_name}/SKILL.md
func (r *systemPromptResolver) Resolve(
	ctx context.Context,
	threadID string,
	userID string,
	userSystem *string,
	selectedSkills []string,
) (*string, error) {
	r.logger.Debug("resolving system prompt",
		"thread_id", threadID,
		"user_id", userID,
		"user_system_provided", userSystem != nil,
		"selected_skills", selectedSkills,
	)

	// For cold start (new thread), threadID is empty - skip thread/project system prompt loading
	// since the thread doesn't exist yet. Just return user-provided system prompt if any.
	if threadID == "" {
		r.logger.Debug("cold start detected (empty threadID), skipping thread/project system prompt")
		if userSystem != nil && *userSystem != "" {
			return userSystem, nil
		}
		return nil, nil
	}

	var parts []string

	// 1. User-provided system prompt (highest priority)
	if userSystem != nil && *userSystem != "" {
		r.logger.Debug("user system prompt found", "length", len(*userSystem))
		parts = append(parts, *userSystem)
	}

	// 2. Load thread to get project ID
	thread, err := r.threadRepo.GetThread(ctx, threadID, userID)
	if err != nil {
		return nil, fmt.Errorf("load thread: %w", err)
	}

	// 3. Load project system prompt
	project, err := r.projectRepo.GetByID(ctx, thread.ProjectID, userID)
	if err != nil {
		return nil, fmt.Errorf("load project: %w", err)
	}
	if project.SystemPrompt != nil && *project.SystemPrompt != "" {
		r.logger.Debug("project system prompt found", "length", len(*project.SystemPrompt))
		parts = append(parts, *project.SystemPrompt)
	}

	// 4. Load thread system prompt
	if thread.SystemPrompt != nil && *thread.SystemPrompt != "" {
		r.logger.Debug("thread system prompt found", "length", len(*thread.SystemPrompt))
		parts = append(parts, *thread.SystemPrompt)
	}

	// 5. Load selected skills
	if len(selectedSkills) > 0 {
		skillsContent, err := r.loadSkills(ctx, thread.ProjectID, selectedSkills)
		if err != nil {
			return nil, fmt.Errorf("load skills: %w", err)
		}
		if skillsContent != "" {
			parts = append(parts, skillsContent)
		}
	}

	// Concatenate all parts
	if len(parts) == 0 {
		r.logger.Debug("no system prompt parts found, returning nil")
		return nil, nil
	}

	result := strings.Join(parts, "\n\n")
	r.logger.Debug("system prompt resolved",
		"total_length", len(result),
		"parts_count", len(parts),
	)
	return &result, nil
}

// loadSkills loads the SKILL.md content for each selected skill
func (r *systemPromptResolver) loadSkills(
	ctx context.Context,
	projectID string,
	selectedSkills []string,
) (string, error) {
	r.logger.Debug("loading skills",
		"project_id", projectID,
		"skills_count", len(selectedSkills),
		"skills", selectedSkills,
	)

	var parts []string

	// Add header explaining the skills
	if len(selectedSkills) > 0 {
		parts = append(parts, "You have access to the following skills. View additional reference materials using tree(\".skills/{skill_name}\") and view(\".skills/{skill_name}/{file}\"):")
	}

	loadedCount := 0
	for _, skillName := range selectedSkills {
		// Query for document at .skills/{skillName}/SKILL
		doc, err := r.getSkillDocument(ctx, projectID, skillName)
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
			"content_length", len(doc.Content),
		)
		loadedCount++

		// Format skill with path and code block wrapper
		skillPath := fmt.Sprintf(".skills/%s/SKILL", skillName)
		skillFormatted := fmt.Sprintf("%s:\n```\n%s\n```", skillPath, doc.Content)
		parts = append(parts, skillFormatted)
	}

	r.logger.Debug("skills loading complete",
		"requested", len(selectedSkills),
		"loaded", loadedCount,
		"failed", len(selectedSkills)-loadedCount,
	)

	return strings.Join(parts, "\n\n"), nil
}

// getSkillDocument retrieves the SKILL.md document for a given skill.
// TODO: When adding skill management UI, consider migrating to a SkillService
// that abstracts skill document loading (currently uses documentRepo directly).
func (r *systemPromptResolver) getSkillDocument(
	ctx context.Context,
	projectID string,
	skillName string,
) (*docsysModels.Document, error) {
	// Construct path: .skills/{skillName}/SKILL
	// NOTE: Anthropic's Claude Code specification requires skills to be .md files,
	// but our database doesn't store file extensions. When importing/exporting,
	// the file is SKILL.md on disk, but stored as "SKILL" in the database.
	// GetByPath expects paths without extensions to match storage convention.
	path := fmt.Sprintf(".skills/%s/SKILL", skillName)

	// Use GetByPath to retrieve the document
	doc, err := r.documentRepo.GetByPath(ctx, path, projectID)
	if err != nil {
		return nil, fmt.Errorf("get skill document '%s': %w", skillName, err)
	}

	return doc, nil
}
