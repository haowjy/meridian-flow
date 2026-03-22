package collab

import "context"

// UpdateLogEntry is one append-only Yjs update row.
type UpdateLogEntry struct {
	ID     int64
	Update []byte
}

// UpdateLogStore persists append-only Yjs update rows.
type UpdateLogStore interface {
	AppendUpdate(ctx context.Context, docID string, update []byte, origin string, userID *string) (int64, error)
	LoadSinceCheckpoint(ctx context.Context, docID string) (checkpoint []byte, updates [][]byte, err error)
	CountUpdates(ctx context.Context, docID string) (int64, error)
	DeleteUpTo(ctx context.Context, docID string, cutoffID int64) error
	GetLatestUpdateID(ctx context.Context, docID string) (int64, error)
	ListDocumentsWithMinUpdates(ctx context.Context, minUpdates int64) ([]string, error)
	GetNthOldestUpdateID(ctx context.Context, docID string, n int64) (int64, error)
	ListUpdatesInRange(ctx context.Context, docID string, afterID int64, upToID int64) ([]UpdateLogEntry, error)
	AcquireCompactionLock(ctx context.Context, docID string) error
}
