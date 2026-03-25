package llm

import "context"

// WorkContext carries work session context for system prompt injection (position 3).
// Nil WorkContext means no active work session — position 3 produces empty content.
type WorkContext struct {
	WorkDir  string // e.g. ".meridian/work/<slug>/"
	FSDir    string // e.g. ".meridian/fs/"
	ThreadID string
	WorkItem string // slug
}

// PromptContext carries all inputs needed to build the final system prompt.
// It replaces the multi-parameter Resolve signature to allow forward extension
// without breaking call sites.
//
// Extension points (PersonaBody, WorkContext) are nil by default, meaning no
// additional content is injected at those positions. This ensures existing
// behavior is preserved when only the core fields are set.
//
// PersonaBody is *string (not *agents.Persona) to keep domain/llm decoupled
// from domain/agents — callers pre-render the body before passing it here.
type PromptContext struct {
	ThreadID       string
	ProjectID      string
	UserID         string
	UserSystem     *string  // from request_params.system; maps to thread prompt slot (position 5)
	SelectedSkills []string
	ToolSection    string // pre-built by ToolRegistry.BuildSystemPromptSection()
	// Extension points — nil = no-op (position produces empty string)
	PersonaBody  *string      // pre-rendered markdown body of a persona; position 7
	PersonaModel *string      // model override from persona (consumed by caller, not resolver)
	WorkContext  *WorkContext // active work session context; position 3
}

// SystemPromptResolver resolves system prompts from multiple sources.
// Combines base identity, tool section, work context, project prompts,
// thread prompts, skill prompts, and persona body into a consolidated
// system prompt for LLM requests.
//
// Composition order (7 positions):
//  1. Base identity (Meridian identity string)
//  2. Tool section (pre-built by ToolRegistry; appended to base identity)
//  3. Work context (from WorkContext; empty when nil)
//  4. Project system prompt
//  5. Thread system prompt (UserSystem from request_params, then thread.system_prompt)
//  6. Skills content
//  7. Persona body (from PersonaBody; empty when nil)
type SystemPromptResolver interface {
	// Resolve builds the final system prompt from all sources in PromptContext.
	// Always returns at least the base identity prompt.
	// Positions 3 and 7 produce empty content when their fields are nil.
	Resolve(ctx context.Context, pc PromptContext) (string, error)
}
