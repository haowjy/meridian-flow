# Phase P5: Persona API Endpoints

## Scope
Read-only endpoints to list personas and include persona info in thread responses.

## Files to Create
- `backend/internal/handler/persona.go`

## Files to Modify
- `backend/internal/app/domains/agents.go` — wire persona endpoints
- `backend/internal/handler/thread.go` — include persona + work_item_id in thread response

## Key Details
- GET /api/projects/{id}/agents → list personas from catalog (valid + invalid)
- Thread detail response gains persona, work_item_id fields
- Read-only — no state changes

## Verification Criteria
- [ ] List agents returns valid + invalid entries
- [ ] Thread detail includes persona slug
- [ ] Thread detail includes work_item_id
- [ ] `make test` passes, `go vet ./...` clean
