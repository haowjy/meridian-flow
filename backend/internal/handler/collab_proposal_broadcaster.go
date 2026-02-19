package handler

import (
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
)

// ProposalBroadcasterImpl implements tools.ProposalBroadcaster by wrapping the
// existing DocumentBroadcaster WS infrastructure. This bridges the gap between
// tool-created proposals (which bypass the WS command path) and connected clients.
type ProposalBroadcasterImpl struct {
	documentBroadcaster collabSvc.DocumentBroadcaster
}

// NewProposalBroadcasterImpl creates a broadcaster backed by the document WS broadcaster.
func NewProposalBroadcasterImpl(documentBroadcaster collabSvc.DocumentBroadcaster) *ProposalBroadcasterImpl {
	return &ProposalBroadcasterImpl{
		documentBroadcaster: documentBroadcaster,
	}
}

// BroadcastProposalCreated sends a proposal:new event to all document subscribers.
func (b *ProposalBroadcasterImpl) BroadcastProposalCreated(documentID string, proposal *collabModels.Proposal) error {
	event := buildProposalNewEvent(*proposal)
	eventBytes, err := json.Marshal(event)
	if err != nil {
		return err
	}
	b.documentBroadcaster.Broadcast(documentID, eventBytes, nil)
	return nil
}

// BroadcastProposalAccepted sends a Yjs update frame followed by a proposal:statusChanged
// event to all document subscribers. This mirrors broadcastProposalMutations for
// the auto-accept case.
func (b *ProposalBroadcasterImpl) BroadcastProposalAccepted(documentID string, proposalID uuid.UUID, yjsUpdate []byte) error {
	documentUUID, err := parseUUID(documentID)
	if err != nil {
		return fmt.Errorf("invalid document id for proposal broadcast: %w", err)
	}

	// Send Yjs update frame so connected editors apply the change
	if len(yjsUpdate) > 0 {
		updateFrame, err := buildUpdateFrame(documentUUID, yjsUpdate)
		if err != nil {
			return err
		}
		b.documentBroadcaster.Broadcast(documentID, updateFrame, nil)
	}

	// Send status changed event so UI updates the proposal badge
	statusEventBytes, err := buildProposalStatusChangedEventBytes(documentUUID, proposalID, collabModels.ProposalStatusAccepted)
	if err != nil {
		return err
	}
	b.documentBroadcaster.Broadcast(documentID, statusEventBytes, nil)
	return nil
}
