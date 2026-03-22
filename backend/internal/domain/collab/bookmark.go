package collab

import (
	"context"
	"time"
)

// Bookmark is a point-in-time reference into the update log.
type Bookmark struct {
	ID           string
	DocumentID   string
	UpdateID     *int64
	State        []byte
	BookmarkType string
	TurnID       *string
	Name         *string
	CreatedBy    *string
	CreatedAt    time.Time
}

// BookmarkStore persists document bookmarks.
type BookmarkStore interface {
	Create(ctx context.Context, bookmark *Bookmark) error
	ListByDocumentAndType(ctx context.Context, docID string, bookmarkType string) ([]Bookmark, error)
	ListByTurnID(ctx context.Context, turnID string) ([]Bookmark, error)
	GetState(ctx context.Context, bookmarkID string) ([]byte, error)
	MaterializeState(ctx context.Context, bookmarkID string, state []byte) error
	DeleteByTypeAndCutoff(ctx context.Context, docID string, bookmarkType string, cutoffUpdateID int64) error
}
