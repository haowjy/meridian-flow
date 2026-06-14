# Phase P3: Persona → System Prompt + Model Override

## Scope
Wire persona body into system prompt position 7, work context into position 3, and apply model/temperature/max_tokens overrides.

## Dependencies: P2

## Files to Modify
- `backend/internal/service/llm/streaming/system_prompt_resolver.go` — populate positions 3 and 7 from PromptContext
- `backend/internal/service/llm/streaming/assemble_prompt.go` — pass persona body + work context to PromptContext, apply model override

## Key Details
- Position 3: work context section from ResolvedContext (WorkDir, FSDir, etc.)
- Position 7: persona body (markdown after frontmatter)
- Model override: persona.Model replaces request model
- Temperature/max_tokens override when persona specifies them
- PromptContext carries PersonaBody *string (already defined in R2)
- No persona → positions 3+7 empty (backward compat)

## Verification Criteria
- [ ] Persona body at position 7
- [ ] Work context at position 3
- [ ] Persona model overrides request model
- [ ] No persona → positions 3+7 empty
- [ ] `make test` passes, `go vet ./...` clean
