# Phase P1: Persona Domain + Catalog Service

## Scope
Full PersonaCatalog implementation with model validation via capability registry. Extends the base catalog from A3b with model availability checks.

## Dependencies
- A3b (base PersonaCatalog implementation)

## Files to Modify
- `backend/internal/domain/agents/types.go` — ensure all Persona fields match design
- `backend/internal/domain/agents/interfaces.go` — ensure PersonaCatalog has all required methods
- `backend/internal/service/agents/persona_catalog.go` — add model validation via CapabilityRegistry

## Files to Create
- `backend/internal/service/agents/persona_catalog_impl.go` — extended catalog with validation (or modify existing)
- `backend/internal/service/agents/persona_catalog_impl_test.go`

## Key Details
- ResolvePersona validates model availability via CapabilityRegistry
- Unknown/unavailable model → PERSONA_INVALID error
- ListUserPersonas: filter by BoolDefaultTrue(UserInvocable) == true
- ListSpawnablePersonas: filter by DisableModelInvocation == false
- Skills references validated against file tree

## Verification Criteria
- [ ] Valid persona → resolves correctly
- [ ] Unknown model → PERSONA_INVALID
- [ ] ListUserPersonas excludes user_invocable=false
- [ ] ListSpawnablePersonas excludes disable_model_invocation=true
- [ ] `make test` passes, `go vet ./...` clean
