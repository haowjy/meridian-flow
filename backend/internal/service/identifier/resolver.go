package identifier

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"meridian/internal/domain"
	docsysRepo "meridian/internal/domain/repositories/docsystem"
)

// ChainedResolver implements the Resolver interface using a strategy chain.
// It tries UUID first (most common), then slug (projects) or path (documents),
// allowing extensibility for future identifier types (short codes, aliases, etc.)
type ChainedResolver struct {
	projectRepo  docsysRepo.ProjectRepository
	documentRepo docsysRepo.DocumentRepository
}

// NewResolver creates a new ChainedResolver.
func NewResolver(projectRepo docsysRepo.ProjectRepository, documentRepo docsysRepo.DocumentRepository) *ChainedResolver {
	return &ChainedResolver{
		projectRepo:  projectRepo,
		documentRepo: documentRepo,
	}
}

// ResolveProject resolves an identifier (UUID or slug) to a project UUID.
// Strategy chain:
// 1. Try as UUID (most common case)
// 2. Try as slug
// 3. Future: short codes, aliases, etc.
func (r *ChainedResolver) ResolveProject(ctx context.Context, identifier, userID string) (string, error) {
	// Strategy 1: Try as UUID first
	if isUUID(identifier) {
		project, err := r.projectRepo.GetByID(ctx, identifier, userID)
		if err == nil {
			return project.ID, nil
		}
		// If UUID format but not found, still try slug (could be a slug that looks like a UUID)
		if !errors.Is(err, domain.ErrNotFound) {
			return "", err
		}
	}

	// Strategy 2: Try as slug
	project, err := r.projectRepo.GetBySlug(ctx, identifier, userID)
	if err == nil {
		return project.ID, nil
	}
	if !errors.Is(err, domain.ErrNotFound) {
		return "", err
	}

	// Future Strategy 3: Try as short code, alias, etc.

	return "", domain.ErrNotFound
}

// ResolveDocument resolves an identifier (UUID or path) to a document UUID.
// Strategy chain:
// 1. Try as UUID (most common case)
// 2. Try as path (e.g., "Characters/Heroes/Aria.md")
// 3. Future: short codes, aliases, etc.
func (r *ChainedResolver) ResolveDocument(ctx context.Context, identifier, projectID string) (string, error) {
	// Strategy 1: Try as UUID first
	if isUUID(identifier) {
		doc, err := r.documentRepo.GetByID(ctx, identifier, projectID)
		if err == nil {
			return doc.ID, nil
		}
		// If UUID format but not found, still try path (could be a path that looks like a UUID)
		if !errors.Is(err, domain.ErrNotFound) {
			return "", err
		}
	}

	// Strategy 2: Try as path
	doc, err := r.documentRepo.GetByPath(ctx, identifier, projectID)
	if err == nil {
		return doc.ID, nil
	}
	if !errors.Is(err, domain.ErrNotFound) {
		return "", err
	}

	// Future Strategy 3: Try as short code, alias, etc.

	return "", domain.ErrNotFound
}

// ResolveDocumentIDOnly resolves an identifier to a document UUID without project scoping.
// Only works for UUIDs - paths require project context.
// Use ResolveDocument() when projectID is available for full path support.
func (r *ChainedResolver) ResolveDocumentIDOnly(ctx context.Context, identifier string) (string, error) {
	// Strategy 1: Try as UUID (only option without project context)
	if isUUID(identifier) {
		doc, err := r.documentRepo.GetByIDOnly(ctx, identifier)
		if err == nil {
			return doc.ID, nil
		}
		if !errors.Is(err, domain.ErrNotFound) {
			return "", err
		}
		// UUID format but not found - return not found
		return "", domain.ErrNotFound
	}

	// Not a UUID - likely a path, which requires project context
	return "", domain.NewValidationError("document paths require project context")
}

// isUUID checks if the given string is a valid UUID format.
func isUUID(s string) bool {
	_, err := uuid.Parse(s)
	return err == nil
}
