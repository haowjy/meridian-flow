// Package identifier provides interfaces for identifier resolution (UUID vs slug).
package identifier

import "context"

// Resolver resolves identifiers (UUID or slug) to canonical UUIDs.
// This allows handlers to accept either format without caring about the detection logic.
type Resolver interface {
	// ResolveProject resolves an identifier (UUID or slug) to a project UUID.
	// Returns the project UUID if found, or domain.ErrNotFound if the identifier doesn't match any project.
	ResolveProject(ctx context.Context, identifier, userID string) (uuid string, err error)

	// ResolveDocument resolves an identifier (UUID or slug) to a document UUID.
	// Requires projectID for slug resolution (slugs are unique per project).
	// Returns the document UUID if found, or domain.ErrNotFound if the identifier doesn't match any document.
	ResolveDocument(ctx context.Context, identifier, projectID string) (uuid string, err error)

	// ResolveDocumentIDOnly resolves a document identifier without project context.
	// Only UUID identifiers work - slugs return domain.ErrBadRequest with explanation.
	// Use this for standalone document endpoints where projectID is not in URL.
	ResolveDocumentIDOnly(ctx context.Context, identifier string) (uuid string, err error)
}
