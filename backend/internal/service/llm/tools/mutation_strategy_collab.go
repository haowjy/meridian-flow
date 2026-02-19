package tools

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"

	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
	"meridian/internal/service/collab"
)

// ProposalCreator is an ISP interface for creating proposals (tools package sees only what it needs).
type ProposalCreator interface {
	CreateProposal(ctx context.Context, req collabSvc.CreateProposalRequest) (*collabModels.Proposal, error)
}

// ProposalBroadcaster is an ISP interface for broadcasting proposal WS events.
// Defined in the tools package to avoid circular imports; implemented in the handler package.
type ProposalBroadcaster interface {
	BroadcastProposalCreated(documentID string, proposal *collabModels.Proposal) error
	BroadcastProposalAccepted(documentID string, proposalID uuid.UUID, yjsUpdate []byte) error
}

// CollabProposalStrategy persists edits by creating a collab proposal with Yjs update bytes.
type CollabProposalStrategy struct {
	proposalCreator     ProposalCreator
	proposalBroadcaster ProposalBroadcaster
	converter           *collab.YjsTextConverter
	logger              *slog.Logger
}

// NewCollabProposalStrategy creates a strategy backed by proposal creation and WS broadcasting.
func NewCollabProposalStrategy(
	proposalCreator ProposalCreator,
	proposalBroadcaster ProposalBroadcaster,
	converter *collab.YjsTextConverter,
	logger *slog.Logger,
) *CollabProposalStrategy {
	return &CollabProposalStrategy{
		proposalCreator:     proposalCreator,
		proposalBroadcaster: proposalBroadcaster,
		converter:           converter,
		logger:              logger,
	}
}

// Apply creates a collab proposal from the text diff and broadcasts the appropriate WS event.
func (s *CollabProposalStrategy) Apply(ctx context.Context, input MutationInput) (*MutationResult, error) {
	// No-op short-circuit: identical content -> no proposal, no DB write, no broadcast
	if input.Base == input.NewContent {
		return &MutationResult{
			Message: "No changes needed",
		}, nil
	}

	docUUID, err := uuid.Parse(input.DocumentID)
	if err != nil {
		return nil, fmt.Errorf("invalid document ID: %w", err)
	}

	// Convert text diff to Yjs update bytes
	yjsUpdate, err := s.converter.TextToUpdate(ctx, docUUID, input.NewContent)
	if err != nil {
		return nil, fmt.Errorf("failed to convert text to Yjs update: %w", err)
	}

	// Nil update means content is identical after Yjs processing (no-op)
	if yjsUpdate == nil {
		return &MutationResult{
			Message: "No changes needed",
		}, nil
	}

	// Extract thread context for provenance (Slice 2)
	threadID, turnID, userID, ok := ExtractThreadContext(ctx)
	if !ok {
		// Default to empty strings — don't fail the edit
		threadID = ""
		turnID = ""
		userID = input.UserID
	}

	// Parse provenance UUIDs
	threadUUID, _ := uuid.Parse(threadID)
	userUUID, _ := uuid.Parse(userID)

	var turnUUID *uuid.UUID
	if turnID != "" {
		parsed, err := uuid.Parse(turnID)
		if err == nil {
			turnUUID = &parsed
		}
	}

	// AgentRunID: use turnUUID if available, otherwise generate a new one.
	// In the streaming executor context, each turn is a logical "agent run".
	agentRunID := uuid.New()
	if turnUUID != nil {
		agentRunID = *turnUUID
	}

	var description *string
	if input.Description != "" {
		description = &input.Description
	}

	proposal, err := s.proposalCreator.CreateProposal(ctx, collabSvc.CreateProposalRequest{
		DocumentID:        docUUID,
		Source:            collabModels.ProposalSourceAI,
		ProducerAgentType: "text_editor",
		ThreadID:          threadUUID,
		TurnID:            turnUUID,
		AgentRunID:        agentRunID,
		YjsUpdate:         yjsUpdate,
		Description:       description,
		CreatedByUserID:   userUUID,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create proposal: %w", err)
	}

	// Broadcast based on proposal status
	switch proposal.Status {
	case collabModels.ProposalStatusAccepted:
		// Auto-accepted: broadcast Yjs update + status change
		if err := s.proposalBroadcaster.BroadcastProposalAccepted(input.DocumentID, proposal.ID, proposal.YjsUpdate); err != nil {
			// Log but don't fail — proposal is persisted, broadcast is best-effort
			s.logger.Warn("failed to broadcast proposal accepted", "document_id", input.DocumentID, "proposal_id", proposal.ID, "error", err)
		}
	case collabModels.ProposalStatusProposed:
		// Pending review: broadcast new proposal event
		if err := s.proposalBroadcaster.BroadcastProposalCreated(input.DocumentID, proposal); err != nil {
			s.logger.Warn("failed to broadcast proposal created", "document_id", input.DocumentID, "proposal_id", proposal.ID, "error", err)
		}
	}

	return &MutationResult{
		Message: input.Description,
		Extra: map[string]interface{}{
			"proposal_id": proposal.ID.String(),
			"status":      string(proposal.Status),
		},
	}, nil
}
