package domain

import (
	"errors"
)

// Domain error types
type (
	// NotFoundError indicates a resource was not found
	NotFoundError struct {
		Message      string
		ResourceType string // Type of resource (document, folder, project, etc.)
	}

	// ValidationError indicates invalid input
	ValidationError struct {
		Message string
		Field   string // Optional field that failed validation
	}

	// UnauthorizedError indicates authentication failure
	UnauthorizedError struct {
		Message string
	}

	// ForbiddenError indicates authorization failure
	ForbiddenError struct {
		Message string
	}
)

// Error implementations
func (e *NotFoundError) Error() string     { return e.Message }
func (e *ValidationError) Error() string   { return e.Message }
func (e *UnauthorizedError) Error() string { return e.Message }
func (e *ForbiddenError) Error() string    { return e.Message }

// Is implementations for errors.Is() support with sentinel errors
func (e *NotFoundError) Is(target error) bool     { return target == ErrNotFound }
func (e *ValidationError) Is(target error) bool   { return target == ErrValidation }
func (e *UnauthorizedError) Is(target error) bool { return target == ErrUnauthorized }
func (e *ForbiddenError) Is(target error) bool    { return target == ErrForbidden }

// Sentinel errors for backwards compatibility - use with errors.Is()
var (
	ErrNotFound     = errors.New("not found")
	ErrConflict     = errors.New("already exists")
	ErrValidation   = errors.New("validation failed")
	ErrBadRequest   = errors.New("bad request")
	ErrUnauthorized = errors.New("unauthorized")
	ErrForbidden    = errors.New("forbidden")
	ErrRateLimit    = errors.New("rate limit exceeded")
)

// WebSocket transport error sentinels
var (
	ErrAuthFailed      = errors.New("authentication failed")
	ErrAuthExpired     = errors.New("authentication expired")
	ErrConnectionLimit = errors.New("connection limit exceeded")
	ErrFrameTooLarge   = errors.New("frame too large")
)

// RateLimitError indicates the user has exceeded a concurrency or rate limit.
type RateLimitError struct {
	Message string
}

func (e *RateLimitError) Error() string        { return e.Message }
func (e *RateLimitError) Is(target error) bool { return target == ErrRateLimit }

// NewRateLimitError creates a structured RateLimitError
func NewRateLimitError(message string) *RateLimitError {
	return &RateLimitError{Message: message}
}

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

// ConstraintViolationError indicates data violated a database constraint
type ConstraintViolationError struct {
	Message        string // User-friendly message
	ConstraintType string // "NOT NULL", "CHECK", "UNIQUE", "FOREIGN KEY"
	ColumnName     string // Column that failed constraint (if available)
	ConstraintName string // Constraint name (if available)
	InternalDetail string // Full error details (dev mode only)
}

func (e *ConstraintViolationError) Error() string {
	return e.Message
}

// Is allows errors.Is() to match against ErrValidation
func (e *ConstraintViolationError) Is(target error) bool {
	return target == ErrValidation
}

// Helper functions for creating structured errors

// NewNotFoundError creates a structured NotFoundError
func NewNotFoundError(resourceType, message string) *NotFoundError {
	return &NotFoundError{
		Message:      message,
		ResourceType: resourceType,
	}
}

// NewConflictError creates a structured ConflictError with resource ID
func NewConflictError(resourceType, resourceID, message string) *ConflictError {
	return &ConflictError{
		Message:      message,
		ResourceType: resourceType,
		ResourceID:   resourceID,
	}
}

// NewValidationError creates a structured ValidationError
func NewValidationError(message string) *ValidationError {
	return &ValidationError{
		Message: message,
	}
}

// NewValidationErrorWithField creates a structured ValidationError with field
func NewValidationErrorWithField(message, field string) *ValidationError {
	return &ValidationError{
		Message: message,
		Field:   field,
	}
}

// NewForbiddenError creates a structured ForbiddenError
func NewForbiddenError(message string) *ForbiddenError {
	return &ForbiddenError{
		Message: message,
	}
}

// NewUnauthorizedError creates a structured UnauthorizedError
func NewUnauthorizedError(message string) *UnauthorizedError {
	return &UnauthorizedError{
		Message: message,
	}
}
