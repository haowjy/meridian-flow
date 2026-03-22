package collab

import "context"

// DocumentContentLoader loads raw markdown content for server-side Yjs bootstrap.
// Separated from persistence stores (ISP) because only DocumentSessionManager needs it.
type DocumentContentLoader interface {
	LoadContentForBootstrap(ctx context.Context, docID string) (string, error)
}

// DocumentSessionProvider manages document collaboration sessions.
type DocumentSessionProvider interface {
	GetOrCreateSession(ctx context.Context, documentID string, userID string) (SyncSession, func(), error)
}

// SyncSession represents an active document collaboration session.
type SyncSession interface {
	BuildSyncStep1Payload() ([]byte, error)
	HandleSyncPayload(ctx context.Context, payload []byte, transactionOrigin string) (int, []byte, []byte, error)
}
