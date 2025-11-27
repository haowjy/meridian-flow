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

// systemPromptResolver builds the final system prompt from project, chat, and skills
// Implements llmSvc.SystemPromptResolver interface
type systemPromptResolver struct {
	projectRepo  docsysRepo.ProjectRepository
	chatRepo     llmRepo.ChatRepository
	documentRepo docsysRepo.DocumentRepository
	logger       *slog.Logger
}

// NewSystemPromptResolver creates a new system prompt resolver
func NewSystemPromptResolver(
	projectRepo docsysRepo.ProjectRepository,
	chatRepo llmRepo.ChatRepository,
	documentRepo docsysRepo.DocumentRepository,
	logger *slog.Logger,
) llmSvc.SystemPromptResolver {
	return &systemPromptResolver{
		projectRepo:  projectRepo,
		chatRepo:     chatRepo,
		documentRepo: documentRepo,
		logger:       logger,
	}
}

// Resolve builds the final system prompt by concatenating:
// 1. user-provided system prompt (from request_params.system)
// 2. project.system_prompt
// 3. chat.system_prompt
// 4. Content of each skill's SKILL.md file from .skills/{skill_name}/SKILL.md
func (r *systemPromptResolver) Resolve(
	ctx context.Context,
	chatID string,
	userID string,
	userSystem *string,
	selectedSkills []string,
) (*string, error) {
	r.logger.Info("resolving system prompt",
		"chat_id", chatID,
		"user_id", userID,
		"user_system_provided", userSystem != nil,
		"selected_skills", selectedSkills,
	)

	// For cold start (new chat), chatID is empty - skip chat/project system prompt loading
	// since the chat doesn't exist yet. Just return user-provided system prompt if any.
	if chatID == "" {
		r.logger.Info("cold start detected (empty chatID), skipping chat/project system prompt")
		if userSystem != nil && *userSystem != "" {
			return userSystem, nil
		}
		return nil, nil
	}

	var parts []string

	// 1. User-provided system prompt (highest priority)
	if userSystem != nil && *userSystem != "" {
		r.logger.Info("user system prompt found", "length", len(*userSystem))
		parts = append(parts, *userSystem)
	}

	// 2. Load chat to get project ID
	chat, err := r.chatRepo.GetChat(ctx, chatID, userID)
	if err != nil {
		return nil, fmt.Errorf("load chat: %w", err)
	}

	// 3. Load project system prompt
	project, err := r.projectRepo.GetByID(ctx, chat.ProjectID, userID)
	if err != nil {
		return nil, fmt.Errorf("load project: %w", err)
	}
	if project.SystemPrompt != nil && *project.SystemPrompt != "" {
		r.logger.Info("project system prompt found", "length", len(*project.SystemPrompt))
		parts = append(parts, *project.SystemPrompt)
	}

	// 4. Load chat system prompt
	if chat.SystemPrompt != nil && *chat.SystemPrompt != "" {
		r.logger.Info("chat system prompt found", "length", len(*chat.SystemPrompt))
		parts = append(parts, *chat.SystemPrompt)
	}

	// 5. Load selected skills
	if len(selectedSkills) > 0 {
		skillsContent, err := r.loadSkills(ctx, chat.ProjectID, selectedSkills)
		if err != nil {
			return nil, fmt.Errorf("load skills: %w", err)
		}
		if skillsContent != "" {
			parts = append(parts, skillsContent)
		}
	}

	// Concatenate all parts
	if len(parts) == 0 {
		r.logger.Info("no system prompt parts found, returning nil")
		return nil, nil
	}

	result := strings.Join(parts, "\n\n")
	r.logger.Info("system prompt resolved",
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
	r.logger.Info("loading skills",
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

		r.logger.Info("skill loaded successfully",
			"skill", skillName,
			"content_length", len(doc.Content),
		)
		loadedCount++

		// Format skill with path and code block wrapper
		skillPath := fmt.Sprintf(".skills/%s/SKILL", skillName)
		skillFormatted := fmt.Sprintf("%s:\n```\n%s\n```", skillPath, doc.Content)
		parts = append(parts, skillFormatted)
	}

	r.logger.Info("skills loading complete",
		"requested", len(selectedSkills),
		"loaded", loadedCount,
		"failed", len(selectedSkills)-loadedCount,
	)

	return strings.Join(parts, "\n\n"), nil
}

// getSkillDocument retrieves the SKILL.md document for a given skill
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
