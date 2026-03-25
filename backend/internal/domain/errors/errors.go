// Package errors defines structured domain errors for v1 API conditions.
//
// Each DomainError carries a code (machine-readable string), HTTP status, human-readable
// message, and optional machine-readable detail payload.  Handlers detect *DomainError
// via errors.As and render {code, message, detail} JSON instead of generic problem details.
//
// Usage:
//
//	return domainerrors.SkillNotFound(slug)
//	return domainerrors.WorkItemDone(slug)
package errors

import "net/http"

// DomainError is a structured error for v1 API error conditions.
// It implements the error interface and carries enough information for
// handlers to produce a typed JSON response without inspecting the message string.
type DomainError struct {
	Code    string      // Machine-readable error code (see codes.go)
	Status  int         // Canonical HTTP status for this error
	Message string      // Human-readable description
	Detail  interface{} // Optional machine-readable detail (nil → omitted from response)
}

// Error implements the error interface.
func (e *DomainError) Error() string { return e.Message }

// ---------------------------------------------------------------------------
// Constructor functions
//
// Each function owns the HTTP status so callers never need to know it.
// Detail fields are chosen to give clients enough context to act without
// requiring them to parse the message string.
// ---------------------------------------------------------------------------

// WorkItemDone returns a DomainError indicating the target work item is already completed.
func WorkItemDone(slug string) *DomainError {
	return &DomainError{
		Code:    CodeWorkItemDone,
		Status:  http.StatusConflict,
		Message: "work item is already done",
		Detail:  map[string]interface{}{"slug": slug},
	}
}

// WorkItemDeleted returns a DomainError indicating the target work item has been deleted.
func WorkItemDeleted(slug string) *DomainError {
	return &DomainError{
		Code:    CodeWorkItemDeleted,
		Status:  http.StatusConflict,
		Message: "work item has been deleted",
		Detail:  map[string]interface{}{"slug": slug},
	}
}

// PersonaNotFound returns a DomainError indicating the referenced persona does not exist.
// Uses 422 (not 404) because the slug is syntactically valid but references a
// non-existent persona for this project. 404 is reserved for missing HTTP resources.
func PersonaNotFound(slug string) *DomainError {
	return &DomainError{
		Code:    CodePersonaNotFound,
		Status:  http.StatusUnprocessableEntity,
		Message: "persona not found",
		Detail:  map[string]interface{}{"slug": slug},
	}
}

// PersonaInvalid returns a DomainError indicating the persona exists but fails validation.
func PersonaInvalid(reason string) *DomainError {
	return &DomainError{
		Code:    CodePersonaInvalid,
		Status:  http.StatusUnprocessableEntity,
		Message: "persona is invalid",
		Detail:  map[string]interface{}{"reason": reason},
	}
}

// SkillNotFound returns a DomainError indicating the referenced skill does not exist.
func SkillNotFound(slug string) *DomainError {
	return &DomainError{
		Code:    CodeSkillNotFound,
		Status:  http.StatusNotFound,
		Message: "skill not found",
		Detail:  map[string]interface{}{"slug": slug},
	}
}

// SkillInvalid returns a DomainError indicating the skill exists but fails validation.
func SkillInvalid(reason string) *DomainError {
	return &DomainError{
		Code:    CodeSkillInvalid,
		Status:  http.StatusUnprocessableEntity,
		Message: "skill is invalid",
		Detail:  map[string]interface{}{"reason": reason},
	}
}

// SpawnDepthExceeded returns a DomainError indicating the agent recursion depth limit was reached.
// depth is the limit that was exceeded.
func SpawnDepthExceeded(depth int) *DomainError {
	return &DomainError{
		Code:    CodeSpawnDepthExceeded,
		Status:  http.StatusTooManyRequests,
		Message: "spawn depth limit exceeded",
		Detail:  map[string]interface{}{"depth": depth},
	}
}

// SpawnLimitExceeded returns a DomainError indicating the concurrent spawn limit was reached.
func SpawnLimitExceeded() *DomainError {
	return &DomainError{
		Code:    CodeSpawnLimitExceeded,
		Status:  http.StatusTooManyRequests,
		Message: "concurrent spawn limit exceeded",
		Detail:  nil,
	}
}

// ContextBudgetExceeded returns a DomainError indicating the token budget for context injection was exceeded.
// used is the number of tokens consumed; limit is the configured maximum.
func ContextBudgetExceeded(used, limit int) *DomainError {
	return &DomainError{
		Code:    CodeContextBudgetExceeded,
		Status:  http.StatusRequestEntityTooLarge,
		Message: "context budget exceeded",
		Detail:  map[string]interface{}{"used": used, "limit": limit},
	}
}

// ImportValidationFailed returns a DomainError indicating imported content failed structural validation.
func ImportValidationFailed(reason string) *DomainError {
	return &DomainError{
		Code:    CodeImportValidationFailed,
		Status:  http.StatusUnprocessableEntity,
		Message: "import validation failed",
		Detail:  map[string]interface{}{"reason": reason},
	}
}

// NamespaceAccessDenied returns a DomainError indicating the caller lacks access to the namespace.
func NamespaceAccessDenied(namespace string) *DomainError {
	return &DomainError{
		Code:    CodeNamespaceAccessDenied,
		Status:  http.StatusForbidden,
		Message: "namespace access denied",
		Detail:  map[string]interface{}{"namespace": namespace},
	}
}

// PathTraversalDenied returns a DomainError indicating the path resolves outside the allowed root.
func PathTraversalDenied(path string) *DomainError {
	return &DomainError{
		Code:    CodePathTraversalDenied,
		Status:  http.StatusForbidden,
		Message: "path traversal denied",
		Detail:  map[string]interface{}{"path": path},
	}
}
