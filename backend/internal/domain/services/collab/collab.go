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

// AIContentReader loads the projected AI content for a document.
// This is the content that includes pending AI proposals applied on top of the
// base content. Used by the text editor tool so each str_replace call in a turn
// sees prior edits instead of reading stale base content.
type AIContentReader interface {
	LoadAIContent(ctx context.Context, docID string) (string, error)
}

// DocumentStateStore persists Yjs state plus derived text projections.
type DocumentStateStore interface {
	LoadState(ctx context.Context, docID string) ([]byte, error)
	SaveState(ctx context.Context, docID string, state []byte, content string, aiContent string) error
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

// ProposalStore manages proposal persistence and terminal status transitions.
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
	ListByGroup(
		ctx context.Context,
		proposalGroupID uuid.UUID,
		status *collabModels.ProposalStatus,
	) ([]collabModels.Proposal, error)
	MarkAccepted(ctx context.Context, decision collabModels.ProposalDecision) error
	MarkRejected(ctx context.Context, decision collabModels.ProposalDecision) error
	// CountRecentByDocumentAndStatus counts proposals for a document with the given
	// status that were decided (accepted/rejected) within the lookback window.
	// For "proposed" status, uses created_at instead of decided_at.
	CountRecentByDocumentAndStatus(ctx context.Context, documentID uuid.UUID, status collabModels.ProposalStatus, since time.Time) (int, error)
}

// IdempotencyStore persists request idempotency records for replay/conflict checks.
type IdempotencyStore interface {
	GetByUserAndKey(
		ctx context.Context,
		userID uuid.UUID,
		idempotencyKey string,
	) (*collabModels.IdempotencyRecord, error)
	Create(ctx context.Context, record *collabModels.IdempotencyRecord) error
	DeleteExpired(ctx context.Context, now time.Time) (int64, error)
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
	// by loading from persisted storage. Used by GroupAccept to compose updates safely.
	GetCurrentState(ctx context.Context, documentID uuid.UUID) ([]byte, error)
}

// AutoAcceptPolicyInputs captures project/user tri-state values for proposal auto-accept.
type AutoAcceptPolicyInputs struct {
	Project *bool
	User    *bool
}

// AutoAcceptPolicyStore resolves project/user auto-accept tri-state inputs.
type AutoAcceptPolicyStore interface {
	GetPolicyInputs(ctx context.Context, documentID uuid.UUID, userID uuid.UUID) (*AutoAcceptPolicyInputs, error)
}

// AIContentProjector recomputes and persists ai_content for a document.
type AIContentProjector interface {
	Recompute(ctx context.Context, documentID uuid.UUID) error
}

// ProjectedStateBuilder builds Yjs state bytes that include pending proposals
// applied on top of the base document state. Used by the mutation strategy so
// the converter operates on the same content the text editor sees (ai_content).
type ProjectedStateBuilder interface {
	BuildProjectedState(ctx context.Context, documentID uuid.UUID) ([]byte, error)
}

// ProposalMutationIntent describes what should be broadcast after a successful proposal mutation.
type ProposalMutationIntent struct {
	DocumentID uuid.UUID
	ProposalID uuid.UUID
	Status     collabModels.ProposalStatus
	YjsUpdate  []byte
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
	CreatedByUserID   uuid.UUID
	AgentAutoAccept   *bool
}

// AcceptProposalRequest captures writer proposal-accept command inputs.
type AcceptProposalRequest struct {
	ProposalID        uuid.UUID
	UserID            uuid.UUID
	IdempotencyKey    string
	RequestHash       string
	IdempotencyTTL    time.Duration
	TransactionOrigin string
}

// AcceptProposalResult captures accept response and broadcast intents.
type AcceptProposalResult struct {
	Payload   collabModels.ProposalAcceptResponsePayload
	IsReplay  bool
	Mutations []ProposalMutationIntent
}

// RejectProposalRequest captures writer proposal-reject command inputs.
type RejectProposalRequest struct {
	ProposalID uuid.UUID
	UserID     uuid.UUID
}

// RejectProposalResult captures reject output and broadcast intents.
type RejectProposalResult struct {
	Noop      bool
	Mutations []ProposalMutationIntent
}

// GroupAcceptRequest captures grouped proposal-accept command inputs.
type GroupAcceptRequest struct {
	DocumentID        uuid.UUID
	ProposalGroupID   uuid.UUID
	UserID            uuid.UUID
	IdempotencyKey    string
	RequestHash       string
	IdempotencyTTL    time.Duration
	TransactionOrigin string
}

// GroupAcceptResult captures group-accept outcomes and broadcast intents.
type GroupAcceptResult struct {
	Payload   collabModels.GroupAcceptResponsePayload
	IsReplay  bool
	Mutations []ProposalMutationIntent
}

// ArbiterVerdict is the arbiter's final ruling on whether auto-accept should proceed.
type ArbiterVerdict string

const (
	// ArbiterVerdictPassThrough means the arbiter has no opinion; defer to the baseline.
	ArbiterVerdictPassThrough ArbiterVerdict = "pass_through"
	// ArbiterVerdictAllow means the arbiter explicitly approves auto-accept.
	ArbiterVerdictAllow ArbiterVerdict = "allow"
	// ArbiterVerdictRequireReview means the arbiter overrides auto-accept -> proposal needs writer review.
	ArbiterVerdictRequireReview ArbiterVerdict = "require_review"
)

// ArbiterInput provides the arbiter with proposal metadata and the resolved auto-accept baseline.
type ArbiterInput struct {
	DocumentID         uuid.UUID
	Source             collabModels.ProposalSource
	ProducerAgentType  string
	YjsUpdateSize      int
	BaselineAutoAccept bool
}

// ArbiterDecision captures the arbiter's output for a single proposal evaluation.
type ArbiterDecision struct {
	Verdict ArbiterVerdict
	Reason  string // human-readable explanation (logged, not user-facing)
}

// ArbiterStrategy is a single evaluation rule in the arbiter chain.
// Strategies return PassThrough to defer to the next strategy in the chain.
type ArbiterStrategy interface {
	Name() string
	Evaluate(ctx context.Context, input ArbiterInput) ArbiterDecision
}

// AgentArbiter evaluates AI proposals at creation time and can override auto-accept.
// Implementations must be safe for concurrent use.
type AgentArbiter interface {
	Evaluate(ctx context.Context, input ArbiterInput) ArbiterDecision
}

// ProposalService executes proposal lifecycle operations.
type ProposalService interface {
	CreateProposal(ctx context.Context, req CreateProposalRequest) (*collabModels.Proposal, error)
	AcceptProposal(ctx context.Context, req AcceptProposalRequest) (*AcceptProposalResult, error)
	RejectProposal(ctx context.Context, req RejectProposalRequest) (*RejectProposalResult, error)
	GroupAccept(ctx context.Context, req GroupAcceptRequest) (*GroupAcceptResult, error)
}
