package collab

import "context"

// DocumentResolver is the only collab dependency on the document domain.
type DocumentResolver interface {
	ResolveDocument(ctx context.Context, docID string) (*CollabDocRef, error)
	VerifyOwnership(ctx context.Context, docID string, userID string) (bool, error)
}

// AutoapplyResolver resolves the effective autoapply policy for a document.
type AutoapplyResolver interface {
	ResolveEffectiveAutoapply(ctx context.Context, documentID string) (bool, error)
}
