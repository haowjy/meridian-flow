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
