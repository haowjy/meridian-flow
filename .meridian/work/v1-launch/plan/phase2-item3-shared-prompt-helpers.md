# Phase 2, Item 3: Extract shared prompt helpers

## Scope
Extract duplicated logic between `debug.go` (BuildDebugProviderRequest), `assemble_prompt.go` (assemblePrompt pipeline stage), and `launch_stream.go` (startStreamingExecution) into shared helper methods on Service.

## Problem
Three code paths repeat the same multi-step sequences:
1. **Skill loading** — `uuid.Parse(projectID)` → `skillResolver.List()` → graceful fallback. Duplicated in `assemble_prompt.go:30-43` and `debug.go:126-134`.
2. **Conversation message building** — `GetTurnPath()` → load blocks per turn → `BuildMessages()` → `ReferenceMessageTransformer.TransformMessages()`. Duplicated in `debug.go:158-209` and `launch_stream.go:240-293`.

These are the shared foundations that Phase 3's collaborators will need.

## Approach

### Helper 1: `loadAvailableSkills`
```go
func (s *Service) loadAvailableSkills(ctx context.Context, projectID string) []domainagents.RuntimeSkill
```
Handles UUID parse, calls `skillResolver.List`, logs warnings on failure, returns empty slice on any error. No error return — callers already treat this as best-effort.

### Helper 2: `buildConversationMessages`
```go
func (s *Service) buildConversationMessages(
    ctx context.Context,
    turnID string, // The turn to build path from (prev_turn_id)
    userID string,
    projectID string,
) ([]domainllm.Message, error)
```
Combines: GetTurnPath → load blocks → BuildMessages → ReferenceMessageTransformer.TransformMessages. Returns fully-processed messages ready for GenerateRequest.

### Helper 3: `buildTempToolRegistry`
```go
func (s *Service) buildTempToolRegistry(
    enabledTools []string,
    projectID string,
    userID string,
    workItemSlug string,
    availableSkills []domainagents.RuntimeSkill,
    persona *domainagents.ResolvedPersona, // nil for non-persona / debug
) *tools.ToolRegistry
```
Builds the temp tool registry used for system prompt section generation. Shared between `assemblePrompt` and `BuildDebugProviderRequest`. NOT the production registry (that has spawn tool, different lifecycle).

### Where to put them
New file: `backend/internal/service/llm/streaming/prompt_helpers.go`

## Files to Modify
- `backend/internal/service/llm/streaming/prompt_helpers.go` (NEW) — shared helpers
- `backend/internal/service/llm/streaming/assemble_prompt.go` — use `loadAvailableSkills`, `buildTempToolRegistry`
- `backend/internal/service/llm/streaming/debug.go` — use all three helpers
- `backend/internal/service/llm/streaming/launch_stream.go` — use `buildConversationMessages` in `startStreamingExecution`

## Dependencies
- Runs after Item 1 (SetSpawnInvoker callback) since both touch `service.go` and `launch_stream.go`
- `loadAvailableSkills` depends on `skillResolver` field (already exists)
- `buildConversationMessages` depends on `turnNavigator`, `turnReader`, `messageBuilder`, `documentSvc`, `folderSvc`, `formatterRegistry`, `logger` (all existing fields)

## Patterns to Follow
- Match existing Service method style (receiver on `*Service`, logger.Debug/Warn for non-fatal)
- Best-effort pattern for skill loading (log, don't fail)
- Error wrapping with `fmt.Errorf("... : %w", err)` for message building

## Verification Criteria
- [ ] `cd backend && go build ./...` compiles
- [ ] `cd backend && go vet ./...` passes
- [ ] No skill loading logic remains in `assemble_prompt.go` or `debug.go` (moved to helper)
- [ ] No conversation message building logic remains in `debug.go` or `startStreamingExecution` (moved to helper)
- [ ] `debug.go` BuildDebugProviderRequest is significantly shorter
- [ ] `startStreamingExecution` in launch_stream.go is significantly shorter
