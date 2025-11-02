package domain

import "errors"

// Domain errors - use with errors.Is()
var (
	// ErrNotFound indicates a resource was not found
	ErrNotFound = errors.New("not found")

	// ErrConflict indicates a unique constraint violation
	ErrConflict = errors.New("already exists")

	// ErrValidation indicates invalid input
	ErrValidation = errors.New("validation failed")

	// ErrUnauthorized indicates authentication failure
	ErrUnauthorized = errors.New("unauthorized")

	// ErrForbidden indicates authorization failure
	ErrForbidden = errors.New("forbidden")
)

// ConflictError represents a resource conflict with details about the existing resource
type ConflictError struct {
	Message      string // Human-readable error message
	ResourceType string // Type of resource (document, folder, project)
	ResourceID   string // ID of the existing/conflicting resource
}

// Error implements the error interface
func (e *ConflictError) Error() string {
	return e.Message
}

// Is allows errors.Is() to match against ErrConflict
func (e *ConflictError) Is(target error) bool {
	return target == ErrConflict
}
