# Phase P4: Persona → Tool Filtering + Skill Override

## Scope
Apply persona tool restrictions and skill overrides during turn creation.

## Dependencies: P2, SM

## Files to Modify
- `backend/internal/service/llm/tools/builder.go` — add WithPersonaToolFilter
- `backend/internal/service/llm/streaming/assemble_prompt.go` — apply persona tools/skills

## Key Details
- Persona with Tools=[...]: only register those tools
- Persona with DisallowedTools=[...]: remove from inherited set
- Persona with Skills=[...]: load those skills instead of client-provided selected_skills
- ToolRegistryBuilder gains WithPersonaToolFilter(allowedTools, disallowedTools)

## Verification Criteria
- [ ] Persona with Tools=["doc_search"] → only doc_search
- [ ] Persona with DisallowedTools=["web_search"] → removed
- [ ] Persona with Skills → override client skills
- [ ] No persona → all tools inherited
- [ ] `make test` passes, `go vet ./...` clean
