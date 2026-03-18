package collab

import (
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
	DecidedByUserID   *uuid.UUID     `json:"decided_by_user_id,omitempty"`
	CreatedAt         time.Time      `json:"created_at"`
	DecidedAt         *time.Time     `json:"decided_at,omitempty"`
}
