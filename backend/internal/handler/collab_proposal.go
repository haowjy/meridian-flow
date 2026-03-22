package handler

import (
	"encoding/base64"
	"time"

	"github.com/google/uuid"

	collab "meridian/internal/domain/collab"
)

const (
	wsTypeHeartbeat        = "heartbeat"
	wsTypeProposalNew      = "proposal:new"
	wsTypeDocumentRestored = "document:restored"
)

type collabTypedMessage struct {
	Type string `json:"type"`
}

type proposalEventDTO struct {
	ID                string  `json:"id"`
	DocumentID        string  `json:"documentId"`
	Source            string  `json:"source"`
	ProducerAgentType string  `json:"producerAgentType"`
	ThreadID          string  `json:"threadId"`
	TurnID            *string `json:"turnId"`
	AgentRunID        string  `json:"agentRunId"`
	ProposalGroupID   *string `json:"proposalGroupId"`
	Status            string  `json:"status"`
	YjsUpdate         *string `json:"yjsUpdate,omitempty"`
	Description       *string `json:"description"`
	CreatedByUserID   string  `json:"createdByUserId"`
	CreatedAt         string  `json:"createdAt"`
}

type proposalNewEvent struct {
	Type     string           `json:"type"`
	Proposal proposalEventDTO `json:"proposal"`
}

func buildProposalNewEvent(proposal collab.Proposal) proposalNewEvent {
	return proposalNewEvent{
		Type:     wsTypeProposalNew,
		Proposal: toProposalEventDTO(proposal, true),
	}
}

func toProposalEventDTO(proposal collab.Proposal, includeYjsUpdate bool) proposalEventDTO {
	turnID := uuidToPtrString(proposal.TurnID)
	groupID := uuidToPtrString(proposal.ProposalGroupID)

	var yjsUpdate *string
	if includeYjsUpdate {
		encoded := base64.StdEncoding.EncodeToString(proposal.YjsUpdate)
		yjsUpdate = &encoded
	}

	return proposalEventDTO{
		ID:                proposal.ID.String(),
		DocumentID:        proposal.DocumentID.String(),
		Source:            string(proposal.Source),
		ProducerAgentType: proposal.ProducerAgentType,
		ThreadID:          proposal.ThreadID.String(),
		TurnID:            turnID,
		AgentRunID:        proposal.AgentRunID.String(),
		ProposalGroupID:   groupID,
		Status:            string(proposal.Status),
		YjsUpdate:         yjsUpdate,
		Description:       proposal.Description,
		CreatedByUserID:   proposal.CreatedByUserID.String(),
		CreatedAt:         proposal.CreatedAt.UTC().Format(time.RFC3339),
	}
}

func uuidToPtrString(v *uuid.UUID) *string {
	if v == nil {
		return nil
	}
	s := v.String()
	return &s
}
