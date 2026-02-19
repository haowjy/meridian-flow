package collab

import (
	"context"
	"time"

	"github.com/google/uuid"

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
	DocumentID        uuid.UUID
	Source            collabModels.ProposalSource
	ProducerAgentType string
	YjsUpdateSize     int
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
