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
	) (string, error)
	ListSnapshots(ctx context.Context, docID string, limit, offset int) ([]collabModels.Snapshot, int, error)
	GetSnapshot(ctx context.Context, snapshotID string) (*collabModels.SnapshotWithState, error)
	DeleteSnapshot(ctx context.Context, snapshotID string) error
	// DeleteExpiredAutoSnapshots removes auto snapshots older than the given TTL.
	// Returns the number of deleted rows.
	DeleteExpiredAutoSnapshots(ctx context.Context, ttlHours int) (int64, error)
}

// DocumentTouchStore records and queries document-turn provenance.
type DocumentTouchStore interface {
	RecordTouch(ctx context.Context, documentID, threadID, turnID string) error
	ListByDocument(ctx context.Context, documentID string, limit, offset int) ([]collabModels.DocumentTouch, error)
	ListByTurn(ctx context.Context, turnID string) ([]collabModels.DocumentTouch, error)
}

// DocumentResolver is the only collab dependency on the document domain.
type DocumentResolver interface {
	ResolveDocument(ctx context.Context, docID string) (*collabModels.CollabDocRef, error)
	VerifyOwnership(ctx context.Context, docID string, userID string) (bool, error)
}
