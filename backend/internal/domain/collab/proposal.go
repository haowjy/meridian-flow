package collab

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// ProposalSource identifies how a proposal was produced.
type ProposalSource string

const (
	ProposalSourceAI             ProposalSource = "ai"
	ProposalSourceTemplate       ProposalSource = "template"
	ProposalSourceUserSuggestion ProposalSource = "user_suggestion"
)

// ProposalStatus is the lifecycle state for a proposal row.
type ProposalStatus string

const (
	ProposalStatusPending  ProposalStatus = "pending"
	ProposalStatusAccepted ProposalStatus = "accepted"
	ProposalStatusRejected ProposalStatus = "rejected"
	ProposalStatusStale    ProposalStatus = "stale"
	ProposalStatusReverted ProposalStatus = "reverted"
	ProposalStatusInvalid  ProposalStatus = "invalid"
)

// Proposal stores an AI/template/user-suggestion edit proposal as a Yjs update buffer.
type Proposal struct {
	ID                uuid.UUID      `json:"id"`
	DocumentID        uuid.UUID      `json:"document_id"`
	Source            ProposalSource `json:"source"`
	ProducerAgentType string         `json:"producer_agent_type"`
	ThreadID          uuid.UUID      `json:"thread_id"`
	TurnID            *uuid.UUID     `json:"turn_id,omitempty"`
	AgentRunID        uuid.UUID      `json:"agent_run_id"`
	ProposalGroupID   *uuid.UUID     `json:"proposal_group_id,omitempty"`
	Status            ProposalStatus `json:"status"`
	YjsUpdate         []byte         `json:"-"`
	Description       *string        `json:"description,omitempty"`
	RegionTextBefore  *string        `json:"region_text_before,omitempty"`
	RegionTextAfter   *string        `json:"region_text_after,omitempty"`
	ProposedAtOffset  *int           `json:"proposed_at_offset,omitempty"`
	AcceptedAtOffset  *int           `json:"accepted_at_offset,omitempty"`
	OffsetVersion     int            `json:"offset_version"`
	CreatedByUserID   uuid.UUID      `json:"created_by_user_id"`
	CreatedAt         time.Time      `json:"created_at"`
}

// ProposalStore manages proposal persistence and mirrored status transitions.
type ProposalStore interface {
	Create(ctx context.Context, proposal *Proposal) error
	GetByID(ctx context.Context, proposalID uuid.UUID) (*Proposal, error)
	CountByDocumentAndStatusAndSource(
		ctx context.Context,
		documentID uuid.UUID,
		status ProposalStatus,
		source ProposalSource,
	) (int, error)
	CountByDocumentAndTurnID(ctx context.Context, documentID uuid.UUID, turnID uuid.UUID) (int, error)
	ListByDocument(
		ctx context.Context,
		documentID uuid.UUID,
		status *ProposalStatus,
		limit int,
		offset int,
	) ([]Proposal, error)
	UpsertStatus(ctx context.Context, proposalID uuid.UUID, status ProposalStatus) error
	SetAcceptedAtOffset(ctx context.Context, proposalID uuid.UUID, offset int, version int) error
	// CountRecentByDocumentAndStatus counts proposals for a document with the given
	// status that were created within the lookback window.
	CountRecentByDocumentAndStatus(ctx context.Context, documentID uuid.UUID, status ProposalStatus, since time.Time) (int, error)
}

// CreateProposalRequest captures proposal-creation inputs from internal producers.
type CreateProposalRequest struct {
	DocumentID        uuid.UUID
	Source            ProposalSource
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

// SetProposalOffsetRequest captures accept-offset updates from transport handlers.
type SetProposalOffsetRequest struct {
	ProposalID       uuid.UUID
	UserID           string
	AcceptedAtOffset int
	OffsetVersion    int
}

// ProposalService executes proposal lifecycle operations.
type ProposalService interface {
	CreateProposal(ctx context.Context, req CreateProposalRequest) (*Proposal, error)
	SetProposalOffset(ctx context.Context, req SetProposalOffsetRequest) error
}
