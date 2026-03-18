package collab

import (
	"context"
	"time"

	"github.com/google/uuid"

	collabModels "meridian/internal/domain/models/collab"
)

// DocumentContentLoader loads raw markdown content for server-side Yjs bootstrap.
// Separated from state/snapshot stores (ISP) because only DocumentSessionManager needs it.
type DocumentContentLoader interface {
	LoadContentForBootstrap(ctx context.Context, docID string) (string, error)
}

// DocumentStateStore persists Yjs state plus derived text projections.
type DocumentStateStore interface {
	LoadState(ctx context.Context, docID string) ([]byte, error)
	SaveState(ctx context.Context, docID string, state []byte, content string) error
}

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

// CheckpointStore persists compacted Yjs checkpoints.
type CheckpointStore interface {
	GetLatest(ctx context.Context, docID string) (state []byte, upToID int64, err error)
	Create(ctx context.Context, docID string, state []byte, upToID int64) error
}

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

// SnapshotStore persists restore/history points for collab documents.
type SnapshotStore interface {
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

// ProposalStore manages proposal persistence and mirrored status transitions.
type ProposalStore interface {
	Create(ctx context.Context, proposal *collabModels.Proposal) error
	GetByID(ctx context.Context, proposalID uuid.UUID) (*collabModels.Proposal, error)
	CountByDocumentAndStatusAndSource(
		ctx context.Context,
		documentID uuid.UUID,
		status collabModels.ProposalStatus,
		source collabModels.ProposalSource,
	) (int, error)
	ListByDocument(
		ctx context.Context,
		documentID uuid.UUID,
		status *collabModels.ProposalStatus,
		limit int,
		offset int,
	) ([]collabModels.Proposal, error)
	UpsertStatus(ctx context.Context, proposalID uuid.UUID, status collabModels.ProposalStatus) error
	SetAcceptedAtOffset(ctx context.Context, proposalID uuid.UUID, offset int, version int) error
	// CountRecentByDocumentAndStatus counts proposals for a document with the given
	// status that were created within the lookback window.
	CountRecentByDocumentAndStatus(ctx context.Context, documentID uuid.UUID, status collabModels.ProposalStatus, since time.Time) (int, error)
}

// DocumentResolver is the only collab dependency on the document domain.
type DocumentResolver interface {
	ResolveDocument(ctx context.Context, docID string) (*collabModels.CollabDocRef, error)
	VerifyOwnership(ctx context.Context, docID string, userID string) (bool, error)
}

// ProposalRuntime applies Yjs updates to the authoritative in-memory document runtime.
type ProposalRuntime interface {
	ApplyUpdate(ctx context.Context, documentID uuid.UUID, update []byte, origin string) error
	GetStateSnapshot(ctx context.Context, documentID uuid.UUID) ([]byte, bool, error)
	// GetCurrentState returns the current Yjs state for a document. Unlike GetStateSnapshot,
	// this always returns state — from the active in-memory session if one exists, otherwise
	// by loading from persisted storage.
	GetCurrentState(ctx context.Context, documentID uuid.UUID) ([]byte, error)
}

// OwnerTabPresenceTracker reports whether a document has at least one connected owner tab.
type OwnerTabPresenceTracker interface {
	HasOwnerTabs(documentID uuid.UUID) bool
}

// StatusMirror mirrors _proposal_status Y.Map values into proposal rows.
type StatusMirror interface {
	// OnStatusChange handles one _proposal_status key delta.
	// newStatus == nil means the key was deleted and should map to pending.
	OnStatusChange(ctx context.Context, proposalID string, newStatus *string) error
	// ReconcileAll repairs drift for one document by reconciling all proposal rows
	// against the current _proposal_status map snapshot.
	ReconcileAll(ctx context.Context, documentID string, statusMap map[string]string) error
}

// ProjectedStateBuilder builds Yjs state bytes that include pending proposals
// applied on top of the base document state. Used by the mutation strategy so
// the converter operates on the same content as pending proposals.
type ProjectedStateBuilder interface {
	BuildProjectedState(ctx context.Context, documentID uuid.UUID, userID uuid.UUID) ([]byte, error)
}

// CreateProposalRequest captures proposal-creation inputs from internal producers.
type CreateProposalRequest struct {
	DocumentID        uuid.UUID
	Source            collabModels.ProposalSource
	ProducerAgentType string
	ThreadID          uuid.UUID
	TurnID            *uuid.UUID
	AgentRunID        uuid.UUID
	ProposalGroupID   *uuid.UUID
	YjsUpdate         []byte
	Description       *string
	RegionTextBefore  *string
	RegionTextAfter   *string
	ProposedAtOffset  *int
	CreatedByUserID   uuid.UUID
	AgentAutoAccept   *bool
}

// ProposalService executes proposal lifecycle operations.
type ProposalService interface {
	CreateProposal(ctx context.Context, req CreateProposalRequest) (*collabModels.Proposal, error)
}
