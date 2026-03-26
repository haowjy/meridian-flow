package tools

// spawn_agent.go — SpawnAgentTool: LLM-callable tool to spawn child agent threads.
//
// Registration is conditional (see WithSpawnTool in builder.go):
//   - Thread must have an active work item (workItemID non-empty)
//   - SpawnInvoker must be wired (non-nil)
//
// Spawn limits (depth < 3, concurrent per work item < 5) are enforced by SpawnService.
// This tool converts DomainErrors (SPAWN_DEPTH_EXCEEDED, SPAWN_LIMIT_EXCEEDED) into
// LLM-recoverable ErrorResults so the model can adapt its strategy.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	domainerrors "meridian/internal/domain/errors"
	domainllm "meridian/internal/domain/llm"
)

// SpawnAgentToolMetadata returns metadata for the spawn_agent tool.
// This enables OCP compliance - tool self-describes for system prompt generation.
func SpawnAgentToolMetadata() *ToolMetadata {
	return &ToolMetadata{
		Name:        "spawn_agent",
		Description: "Spawn a child agent to handle a focused sub-task; blocks until the child completes",
		Guideline:   "Use spawn_agent to delegate well-scoped work to a specialized sub-agent; avoid deeply nested spawns",
	}
}

// SpawnAgentTool implements the 'spawn_agent' tool.
// It delegates to SpawnInvoker.CreateSpawn and returns the child thread's outcome.
// This is foreground-only: Execute blocks until the child completes or times out.
type SpawnAgentTool struct {
	// parentThreadID is the thread calling spawn_agent (passed to SpawnRequest).
	parentThreadID string
	// workItemID is inherited from the parent thread; passed to SpawnRequest for
	// concurrent-spawn counting and child thread association.
	workItemID string
	// projectID and userID are required to create the child thread via SpawnRequest.
	projectID string
	userID    string
	// spawnInvoker is the narrow interface (implemented by SpawnService) for creating spawns.
	// Guards against nil at registration time; never nil here during Execute.
	spawnInvoker domainllm.SpawnInvoker
}

// NewSpawnAgentTool creates a new SpawnAgentTool instance.
// Precondition: spawnInvoker must be non-nil and workItemID must be non-empty.
// WithSpawnTool in builder.go enforces these preconditions before calling this constructor.
func NewSpawnAgentTool(
	parentThreadID string,
	workItemID string,
	projectID string,
	userID string,
	spawnInvoker domainllm.SpawnInvoker,
) *SpawnAgentTool {
	return &SpawnAgentTool{
		parentThreadID: parentThreadID,
		workItemID:     workItemID,
		projectID:      projectID,
		userID:         userID,
		spawnInvoker:   spawnInvoker,
	}
}

// Execute implements ToolExecutor interface.
//
// Input parameters:
//   - agent  (string, required): Persona slug of the child agent to spawn (e.g., "coder")
//   - prompt (string, required): Task description sent to the child agent as its first user turn
//
// Returns on success:
//
//	{success: true, child_thread_id, status, summary?, artifacts?, metadata?}
//
// Returns ErrorResult on:
//   - Missing/empty agent or prompt parameter
//   - SPAWN_DEPTH_EXCEEDED (depth limit hit — LLM should not spawn deeper)
//   - SPAWN_LIMIT_EXCEEDED (concurrent limit hit — LLM should wait or consolidate work)
//
// Returns a real error (bubbled up) on unexpected infrastructure failures.
func (t *SpawnAgentTool) Execute(ctx context.Context, input map[string]interface{}) (interface{}, error) {
	// Extract and validate agent slug.
	agent, ok := input["agent"].(string)
	if !ok || strings.TrimSpace(agent) == "" {
		return ErrorResult(ErrMissingParam, "Missing required parameter", map[string]any{"param": "agent"}), nil
	}
	agent = strings.TrimSpace(agent)

	// Extract and validate prompt.
	prompt, ok := input["prompt"].(string)
	if !ok || strings.TrimSpace(prompt) == "" {
		return ErrorResult(ErrMissingParam, "Missing required parameter", map[string]any{"param": "prompt"}), nil
	}
	prompt = strings.TrimSpace(prompt)

	req := &domainllm.SpawnRequest{
		ProjectID:      t.projectID,
		UserID:         t.userID,
		ParentThreadID: t.parentThreadID,
		WorkItemID:     t.workItemID,
		AgentSlug:      agent,
		Prompt:         prompt,
	}

	result, err := t.spawnInvoker.CreateSpawn(ctx, req)
	if err != nil {
		// Convert spawn limit/depth domain errors into LLM-recoverable ErrorResults.
		// The LLM can then adapt (e.g., avoid spawning deeper, wait, consolidate work).
		var de *domainerrors.DomainError
		if errors.As(err, &de) {
			switch de.Code {
			case domainerrors.CodeSpawnDepthExceeded:
				return ErrorResult(de.Code, de.Message, map[string]any{
					"detail": de.Detail,
				}), nil
			case domainerrors.CodeSpawnLimitExceeded:
				return ErrorResult(de.Code, de.Message, nil), nil
			}
		}
		// Unexpected infrastructure error — bubble up so the executor can handle it.
		return nil, fmt.Errorf("spawn_agent: %w", err)
	}

	// Build success response. Only include optional fields if present.
	out := map[string]interface{}{
		"success":         true,
		"child_thread_id": result.ChildThreadID,
		"status":          result.Status,
	}
	if result.Summary != "" {
		out["summary"] = result.Summary
	}
	if len(result.Artifacts) > 0 {
		out["artifacts"] = result.Artifacts
	}
	if len(result.Metadata) > 0 {
		out["metadata"] = result.Metadata
	}

	return out, nil
}
