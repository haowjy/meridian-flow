# Phase 1: UUID Validation (Item 15)

## Scope
Add `parseUUID()` validation to handlers that pass raw path params as UUIDs to services. Malformed UUIDs currently bubble as DB 500s — they should return 400 with a clear error message.

## Files to Modify
- `backend/internal/handler/helpers.go` — add `ParseUUID(w, r, param, label) (string, bool)` helper
- `backend/internal/handler/context_budget.go` — use ParseUUID for thread ID (line ~79)
- `backend/internal/handler/spawn.go` — use ParseUUID for thread ID (line ~44)
- `backend/internal/handler/work_item.go` — use ParseUUID for project ID in relevant endpoints

## Implementation

Add to `helpers.go`:
```go
func ParseUUID(w http.ResponseWriter, r *http.Request, param, label string) (string, bool) {
    value, ok := PathParam(w, r, param, label)
    if !ok {
        return "", false
    }
    if _, err := uuid.Parse(value); err != nil {
        httputil.RespondError(w, http.StatusBadRequest, label+" must be a valid UUID")
        return "", false
    }
    return value, true
}
```

Use `github.com/google/uuid` (already a dependency — check go.mod).

Then replace `PathParam` calls with `ParseUUID` where the param is expected to be a UUID.

## Which Params Are UUIDs
- `context_budget.go`: `"id"` (thread ID) — UUID
- `spawn.go`: `"id"` (thread ID) — UUID
- `work_item.go`: `"id"` (project ID) — UUID

## Which Params Are NOT UUIDs (leave as PathParam)
- `work_item.go`: `"slug"` — these are slugs, not UUIDs
- `document.go`: `"id"` — these go through resolveDocumentID which handles its own validation

## Constraints
- Only add validation where the param is genuinely expected to be a UUID
- Don't change slug-based params or identifier params that have their own resolution
- Use the existing `github.com/google/uuid` package

## Verification Criteria
- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go vet ./...` passes
- [ ] Malformed UUID in path returns 400, not 500
