# Phase ERR: Error Code Registry

## Scope
Create structured error codes for all new v1 error conditions. Error types carry a code string, HTTP status, and machine-readable detail.

## Intent
Every subsequent step needs structured errors instead of ad-hoc `fmt.Errorf`. Handler middleware maps these to JSON responses with `{code, message, detail}` shape.

## Files to Create
- `backend/internal/domain/errors/codes.go` — error code constants
- `backend/internal/domain/errors/errors.go` — error types implementing `error` interface

## What Changes

### Error codes (codes.go)
```go
const (
    CodeWorkItemDone        = "WORK_ITEM_DONE"         // 409
    CodeWorkItemDeleted     = "WORK_ITEM_DELETED"       // 409
    CodePersonaNotFound     = "PERSONA_NOT_FOUND"       // 422
    CodePersonaInvalid      = "PERSONA_INVALID"         // 422
    CodeSkillNotFound       = "SKILL_NOT_FOUND"         // 404
    CodeSkillInvalid        = "SKILL_INVALID"           // 422
    CodeSpawnDepthExceeded  = "SPAWN_DEPTH_EXCEEDED"    // 429
    CodeSpawnLimitExceeded  = "SPAWN_LIMIT_EXCEEDED"    // 429
    CodeContextBudgetExceeded = "CONTEXT_BUDGET_EXCEEDED" // 413
    CodeImportValidationFailed = "IMPORT_VALIDATION_FAILED" // 422
    CodeNamespaceAccessDenied  = "NAMESPACE_ACCESS_DENIED"  // 403
    CodePathTraversalDenied    = "PATH_TRAVERSAL_DENIED"    // 403
)
```

### Error types (errors.go)
```go
type DomainError struct {
    Code    string
    Status  int
    Message string
    Detail  interface{} // optional machine-readable detail
}

func (e *DomainError) Error() string { return e.Message }

// Constructor functions for each error type
func WorkItemDone(slug string) *DomainError { ... }
func PersonaNotFound(slug string) *DomainError { ... }
// etc.
```

### Handler middleware integration
Add a helper (or update existing error handling) that checks if an error is `*DomainError` and maps it to the JSON response:
```json
{"code": "WORK_ITEM_DONE", "message": "Work item is completed", "detail": {"slug": "my-feature"}}
```

## Patterns to Follow
- See `backend/internal/handler/error.go` for existing error handling
- See `backend/internal/domain/llm/errors.go` for existing error patterns

## Constraints
- Each code must have a unique string identifier
- HTTP status codes must be semantically correct
- Error types must implement the `error` interface
- Do NOT change existing error handling for current endpoints — only add new infrastructure

## Verification Criteria
- [ ] `make test` passes
- [ ] Error types implement `error` interface
- [ ] Each code has a unique string identifier
- [ ] HTTP status codes are correct per error type
- [ ] Constructor functions return properly populated errors
- [ ] Handler can detect DomainError and produce JSON response
- [ ] `go vet ./...` clean
