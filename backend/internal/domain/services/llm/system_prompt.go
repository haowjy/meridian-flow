package llm

import "context"

// SystemPromptResolver resolves system prompts from multiple sources.
// Combines user-provided prompts, project prompts, chat prompts, and skill prompts
// into a single consolidated system prompt for LLM requests.
type SystemPromptResolver interface {
	// Resolve builds the final system prompt by concatenating:
	// 1. user-provided system prompt (from request_params.system)
	// 2. project.system_prompt
	// 3. chat.system_prompt
	// 4. Content of each skill's SKILL file from .skills/{skill_name}/SKILL
	//
	// Returns nil if no prompts are found.
	Resolve(ctx context.Context, chatID string, userID string, userSystem *string, selectedSkills []string) (*string, error)
}
