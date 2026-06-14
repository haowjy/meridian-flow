# Phase R2: System Prompt Extension Points

## Scope
Replace the multi-param `Resolve()` signature on the system prompt resolver with a `PromptContext` struct. Add 7-position composition order with extension points for persona body and work context (initially nil).

## Intent
P3 (persona -> system prompt) and work context injection both need extension points. This refactor creates them without changing current behavior.

## Files to Modify
- `backend/internal/domain/llm/system_prompt.go` — update `SystemPromptResolver` interface: `Resolve(ctx, PromptContext) (string, error)`
- `backend/internal/service/llm/streaming/system_prompt_resolver.go` — implementation: accept PromptContext, compose 7 positions
- `backend/internal/service/llm/streaming/turn_creation.go` — caller: build PromptContext from existing params, pass to Resolve

## What Changes

### PromptContext struct (in domain/llm)
```go
type PromptContext struct {
    ProjectID    uuid.UUID
    ThreadID     uuid.UUID
    UserID       uuid.UUID
    Model        string
    SelectedSkills []string
    // Extension points (nil = no-op for now)
    PersonaBody  *string   // NOT *agents.Persona — keeps domain/llm independent
    PersonaModel *string
    WorkContext  *WorkContext
}

type WorkContext struct {
    WorkDir    string
    FSDir      string
    ThreadID   string
    WorkItem   string // slug
}
```

### 7-position composition order
1. Base identity (existing)
2. Tool section (existing)
3. Work context (NEW — empty when WorkContext is nil)
4. Project system prompt (existing — was position 2)
5. Thread system prompt (existing — was position 3)
6. Skills content (existing — was position 4)
7. Persona body (NEW — empty when PersonaBody is nil)

Positions 4-5 are project then thread (aligned with streaming-integration.md). User-provided system prompt maps to the thread prompt slot (position 5).

### Critical constraint: no domain coupling
PromptContext lives in `domain/llm`. It must NOT import `domain/agents`. That's why PersonaBody is `*string` (the markdown body after frontmatter), not a full Persona struct.

## Verification Criteria
- [ ] `make test` passes
- [ ] `PromptContext` struct defined with `PersonaBody *string` (not Persona struct)
- [ ] All callers updated (search `Resolve(` across codebase — there should be no old-signature calls)
- [ ] System prompt output identical when new fields are nil (regression test)
- [ ] 7-position ordering implemented with positions 3 and 7 producing empty string when nil
- [ ] No import of `domain/agents` from `domain/llm`
- [ ] `go vet ./...` clean
