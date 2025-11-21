package domain

import (
	"errors"
	"net/http"
)

// HTTPError defines errors that can be mapped to HTTP status codes.
// Implementing this interface enables extensible error handling (OCP compliance).
type HTTPError interface {
	error
	StatusCode() int
}

// Domain error types implementing HTTPError interface
type (
	// NotFoundError indicates a resource was not found
	NotFoundError struct {
		Message string
	}

	// ValidationError indicates invalid input
	ValidationError struct {
		Message string
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
func (e *NotFoundError) Error() string      { return e.Message }
func (e *ValidationError) Error() string    { return e.Message }
func (e *UnauthorizedError) Error() string  { return e.Message }
func (e *ForbiddenError) Error() string     { return e.Message }

// StatusCode implementations (HTTPError interface)
func (e *NotFoundError) StatusCode() int      { return http.StatusNotFound }
func (e *ValidationError) StatusCode() int    { return http.StatusBadRequest }
func (e *UnauthorizedError) StatusCode() int  { return http.StatusUnauthorized }
func (e *ForbiddenError) StatusCode() int     { return http.StatusForbidden }

// Sentinel errors for backwards compatibility - use with errors.Is()
var (
	ErrNotFound     = errors.New("not found")
	ErrConflict     = errors.New("already exists")
	ErrValidation   = errors.New("validation failed")
	ErrUnauthorized = errors.New("unauthorized")
	ErrForbidden    = errors.New("forbidden")
)

// ConflictError represents a resource conflict with details about the existing resource
// Implements HTTPError interface for extensible error handling
type ConflictError struct {
	Message      string // Human-readable error message
	ResourceType string // Type of resource (document, folder, project)
	ResourceID   string // ID of the existing/conflicting resource
}

// Error implements the error interface
func (e *ConflictError) Error() string {
	return e.Message
}

// StatusCode implements the HTTPError interface
func (e *ConflictError) StatusCode() int {
	return http.StatusConflict
}

// Is allows errors.Is() to match against ErrConflict
func (e *ConflictError) Is(target error) bool {
	return target == ErrConflict
}
