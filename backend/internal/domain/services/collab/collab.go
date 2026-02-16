package collab

import (
	"context"

	collabModels "meridian/internal/domain/models/collab"
)

// Connection is transport-agnostic and can represent WebSocket or future transports.
type Connection interface {
	ID() string
	Send(data []byte) error
}

// DocumentBroadcaster fans out binary updates to document subscribers.
type DocumentBroadcaster interface {
	Subscribe(docID string, conn Connection) error
	Unsubscribe(docID string, conn Connection)
	Broadcast(docID string, update []byte, exclude Connection)
}

// DocumentStore persists Yjs state plus derived projections.
type DocumentStore interface {
	LoadState(ctx context.Context, docID string) ([]byte, error)
	SaveState(ctx context.Context, docID string, state []byte, content string, aiContent string) error
	SaveSnapshot(
		ctx context.Context,
		docID string,
		state []byte,
		snapshotType string,
		name *string,
		createdByUserID *string,
	) error
}

// DocumentResolver is the only collab dependency on the document domain.
type DocumentResolver interface {
	ResolveDocument(ctx context.Context, docID string) (*collabModels.CollabDocRef, error)
	VerifyOwnership(ctx context.Context, docID string, userID string) (bool, error)
}
