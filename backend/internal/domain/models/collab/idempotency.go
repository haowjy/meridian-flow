package collab

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// IdempotencyScope defines the operation class for idempotent requests.
type IdempotencyScope string

const (
	IdempotencyScopeProposalAccept IdempotencyScope = "proposal_accept"
	IdempotencyScopeGroupAccept    IdempotencyScope = "group_accept"
)

// IdempotencyRecord stores replayable request/response materialization.
type IdempotencyRecord struct {
	ID              uuid.UUID        `json:"id"`
	UserID          uuid.UUID        `json:"user_id"`
	IdempotencyKey  string           `json:"idempotency_key"`
	RequestScope    IdempotencyScope `json:"request_scope"`
	ScopeID         uuid.UUID        `json:"scope_id"`
	RequestHash     string           `json:"request_hash"`
	DocumentID      uuid.UUID        `json:"document_id"`
	ResponsePayload json.RawMessage  `json:"response_payload"`
	CreatedAt       time.Time        `json:"created_at"`
	ExpiresAt       time.Time        `json:"expires_at"`
}

// GroupAcceptOutcomeStatus captures per-proposal results from group-accept.
type GroupAcceptOutcomeStatus string

const (
	GroupAcceptOutcomeStatusAccepted GroupAcceptOutcomeStatus = "accepted"
	GroupAcceptOutcomeStatusSkipped  GroupAcceptOutcomeStatus = "skipped"
)

// GroupAcceptOutcome aligns with WS group-accept result semantics.
type GroupAcceptOutcome struct {
	ProposalID uuid.UUID                `json:"proposalId"`
	Status     GroupAcceptOutcomeStatus `json:"status"`
	Error      *string                  `json:"error,omitempty"`
}

// ProposalAcceptResponsePayload is the persisted proposal-accept replay payload.
type ProposalAcceptResponsePayload struct {
	ProposalID uuid.UUID `json:"proposalId"`
}

// GroupAcceptResponsePayload is the persisted group-accept replay payload.
type GroupAcceptResponsePayload struct {
	Outcomes []GroupAcceptOutcome `json:"outcomes"`
}
