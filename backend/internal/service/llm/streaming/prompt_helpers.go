package streaming

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	domainagents "meridian/internal/domain/agents"
	domainllm "meridian/internal/domain/llm"
	threadhistory "meridian/internal/service/llm/thread_history"
	"meridian/internal/service/llm/tools"
)

// loadAvailableSkills resolves runtime skills for prompt/tool metadata enrichment.
// This is best-effort by design: failures are logged and an empty slice is returned.
func (s *Service) loadAvailableSkills(ctx context.Context, projectID string) []domainagents.RuntimeSkill {
	projectUUID, err := uuid.Parse(projectID)
	if err != nil {
		s.logger.Warn("failed to parse project UUID for skill loading; skills unavailable",
			"project_id", projectID,
			"error", err,
		)
		return []domainagents.RuntimeSkill{}
	}

	skills, _, err := s.skillResolver.List(ctx, projectUUID)
	if err != nil {
		s.logger.Warn("failed to load skills for tool metadata", "error", err)
		return []domainagents.RuntimeSkill{}
	}

	return skills
}

// buildConversationMessages builds the full provider-ready conversation message list
// for the conversation path rooted at turnID, including @-reference transformation.
//
// For callers that need to insert messages before reference transformation (e.g. debug
// endpoint appending a hypothetical user message), use loadConversationHistory +
// transformMessageReferences separately.
func (s *Service) buildConversationMessages(
	ctx context.Context,
	turnID string,
	userID string,
	projectID string,
) ([]domainllm.Message, error) {
	messages, err := s.loadConversationHistory(ctx, turnID)
	if err != nil {
		return nil, err
	}
	return s.transformMessageReferences(ctx, messages, userID, projectID)
}

// loadConversationHistory loads the turn path and builds LLM messages from it.
// Returns untransformed messages — @-references are NOT yet expanded.
func (s *Service) loadConversationHistory(ctx context.Context, turnID string) ([]domainllm.Message, error) {
	path := []domainllm.Turn{}
	if turnID != "" {
		var err error
		path, err = s.turnNavigator.GetTurnPath(ctx, turnID)
		if err != nil {
			return nil, fmt.Errorf("failed to get turn path: %w", err)
		}

		for i := range path {
			blocks, blocksErr := s.turnReader.GetTurnBlocks(ctx, path[i].ID)
			if blocksErr != nil {
				return nil, fmt.Errorf("failed to get content blocks for turn %s: %w", path[i].ID, blocksErr)
			}
			path[i].Blocks = blocks
		}
	}

	messages, err := s.messageBuilder.BuildMessages(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("failed to build messages: %w", err)
	}
	return messages, nil
}

// transformMessageReferences compiles @-references in messages into synthetic
// tool_use/tool_result pairs for the provider.
func (s *Service) transformMessageReferences(ctx context.Context, messages []domainllm.Message, userID, projectID string) ([]domainllm.Message, error) {
	refTransformer := threadhistory.NewReferenceMessageTransformer(
		s.documentSvc, s.folderSvc, s.formatterRegistry, userID, projectID, s.logger,
	)
	messages, err := refTransformer.TransformMessages(ctx, messages)
	if err != nil {
		return nil, fmt.Errorf("failed to transform references: %w", err)
	}
	return messages, nil
}

// buildTempToolRegistry builds the temporary registry used only for system prompt
// tool section generation (not the production registry used for execution).
func (s *Service) buildTempToolRegistry(
	enabledTools []string,
	projectID string,
	userID string,
	workItemSlug string,
	availableSkills []domainagents.RuntimeSkill,
	persona *domainagents.Persona,
) *tools.ToolRegistry {
	builder := tools.NewToolRegistryBuilder().
		WithNamespaceService(s.namespaceSvc).
		WithMutationStrategy(s.mutationStrategy).
		WithWorkItemSlug(workItemSlug).
		WithEnabledDocumentTools(enabledTools, projectID, userID, s.documentSvc, s.folderSvc).
		WithEnabledSkillTools(enabledTools, projectID, s.skillResolver, false, availableSkills)

	if persona != nil {
		builder.WithPersonaToolFilter(persona.Tools, persona.DisallowedTools)
	}

	return builder.Build()
}
