package collab

import (
	"context"
	"errors"

	"meridian/internal/domain"
	authdomain "meridian/internal/domain/auth"
	collab "meridian/internal/domain/collab"
	domaindocsys "meridian/internal/domain/docsystem"
)

// DocumentResolverAdapter bridges collab with existing document/authorization services.
type DocumentResolverAdapter struct {
	docRepo    domaindocsys.DocumentReader
	authorizer authdomain.ResourceAuthorizer
}

// NewDocumentResolver creates a DocumentResolver backed by current document domain services.
func NewDocumentResolver(
	docRepo domaindocsys.DocumentReader,
	authorizer authdomain.ResourceAuthorizer,
) collab.DocumentResolver {
	return &DocumentResolverAdapter{
		docRepo:    docRepo,
		authorizer: authorizer,
	}
}

// ResolveDocument returns the minimal metadata collab requires for a document.
// Phase 1: Not called yet — VerifyOwnership is the only active path.
// Phase 2+: Used for multi-user room creation where project context is needed.
func (r *DocumentResolverAdapter) ResolveDocument(ctx context.Context, docID string) (*collab.CollabDocRef, error) {
	doc, err := r.docRepo.GetByIDOnly(ctx, docID)
	if err != nil {
		return nil, err
	}

	return &collab.CollabDocRef{
		DocumentID: doc.ID,
		ProjectID:  doc.ProjectID,
	}, nil
}

// VerifyOwnership checks whether a user can access the given document.
func (r *DocumentResolverAdapter) VerifyOwnership(ctx context.Context, docID string, userID string) (bool, error) {
	err := r.authorizer.CanAccessDocument(ctx, userID, docID)
	if err == nil {
		return true, nil
	}

	// Not found/forbidden/unauthorized are mapped to "not owner" without leaking details.
	switch {
	case errors.Is(err, domain.ErrNotFound):
		return false, nil
	case errors.Is(err, domain.ErrForbidden):
		return false, nil
	case errors.Is(err, domain.ErrUnauthorized):
		return false, nil
	default:
		return false, err
	}
}
