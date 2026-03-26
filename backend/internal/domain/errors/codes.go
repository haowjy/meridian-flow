package errors

// Error code constants for all v1 domain error conditions.
// Each code maps to a unique string identifier and a canonical HTTP status (see errors.go).
//
// Codes are grouped by domain area for readability; the HTTP status is enforced in the
// constructor functions, not here, so callers never need to remember the correct status.
const (
	// Work item lifecycle errors (409 Conflict)
	CodeWorkItemDone              = "WORK_ITEM_DONE"               // Operation rejected: work item is already completed
	CodeWorkItemDeleted           = "WORK_ITEM_DELETED"            // Operation rejected: work item has been deleted
	CodeWorkItemHasActiveStreams  = "WORK_ITEM_HAS_ACTIVE_STREAMS" // Cannot complete: work item has in-flight streaming turns

	// Persona errors (422 Unprocessable Entity)
	CodePersonaNotFound = "PERSONA_NOT_FOUND" // Referenced persona does not exist
	CodePersonaInvalid  = "PERSONA_INVALID"   // Persona exists but fails validation

	// Skill errors
	CodeSkillNotFound = "SKILL_NOT_FOUND" // 404 – referenced skill does not exist
	CodeSkillInvalid  = "SKILL_INVALID"   // 422 – skill exists but fails validation

	// Spawn / concurrency errors (429 Too Many Requests)
	CodeSpawnDepthExceeded = "SPAWN_DEPTH_EXCEEDED" // Agent recursion depth exceeded
	CodeSpawnLimitExceeded = "SPAWN_LIMIT_EXCEEDED" // Concurrent spawn count exceeded

	// Context / payload errors (413 Content Too Large)
	CodeContextBudgetExceeded = "CONTEXT_BUDGET_EXCEEDED" // Token budget for context injection exceeded

	// Import errors (422 Unprocessable Entity)
	CodeImportValidationFailed = "IMPORT_VALIDATION_FAILED" // Imported content failed structural validation

	// Access control errors (403 Forbidden)
	CodeNamespaceAccessDenied = "NAMESPACE_ACCESS_DENIED" // Caller lacks access to the target namespace
	CodePathTraversalDenied   = "PATH_TRAVERSAL_DENIED"   // Path resolves outside the allowed root
)
