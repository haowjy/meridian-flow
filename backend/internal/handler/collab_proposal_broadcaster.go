package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"

	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
)

// ProposalBroadcasterImpl implements tools.ProposalBroadcaster by routing JSON
// proposal events to project websocket connections and Yjs frames to document
// websocket connections.
type ProposalBroadcasterImpl struct {
	projectBroadcaster ProjectBroadcaster
	docBroadcaster     DocumentBroadcaster
	documentResolver   collabSvc.DocumentResolver
}

// NewProposalBroadcasterImpl creates a broadcaster backed by the project/document WS handlers.
func NewProposalBroadcasterImpl(
	projectBroadcaster ProjectBroadcaster,
	docBroadcaster DocumentBroadcaster,
	documentResolver collabSvc.DocumentResolver,
) *ProposalBroadcasterImpl {
	return &ProposalBroadcasterImpl{
		projectBroadcaster: projectBroadcaster,
		docBroadcaster:     docBroadcaster,
		documentResolver:   documentResolver,
	}
}

// BroadcastProposalCreated sends a proposal:new event to all project connections
// for the proposal's document.
func (b *ProposalBroadcasterImpl) BroadcastProposalCreated(documentID string, proposal *collabModels.Proposal) error {
	documentUUID, err := parseUUID(documentID)
	if err != nil {
		return fmt.Errorf("invalid document id for proposal broadcast: %w", err)
	}
	canonicalDocumentID := documentUUID.String()

	event := buildProposalNewEvent(*proposal)
	eventBytes, err := json.Marshal(event)
	if err != nil {
		return err
	}

	projectID, err := b.resolveProjectID(context.Background(), canonicalDocumentID)
	if err != nil {
		return err
	}

	if b.projectBroadcaster != nil {
		b.projectBroadcaster.BroadcastToProject(projectID, eventBytes)
	}
	return nil
}

// BroadcastProposalAccepted sends a Yjs update frame to document websocket
// connections. Phase 3 removes project-level statusChanged events.
func (b *ProposalBroadcasterImpl) BroadcastProposalAccepted(documentID string, proposalID uuid.UUID, yjsUpdate []byte) error {
	_ = proposalID

	documentUUID, err := parseUUID(documentID)
	if err != nil {
		return fmt.Errorf("invalid document id for proposal broadcast: %w", err)
	}
	canonicalDocumentID := documentUUID.String()

	if len(yjsUpdate) > 0 && b.docBroadcaster != nil {
		encodedUpdate, err := encodeSyncUpdatePayload(yjsUpdate)
		if err != nil {
			return err
		}
		b.docBroadcaster.BroadcastToDocument(canonicalDocumentID, addDocPrefix(docWSPrefixSync, encodedUpdate))
	}
	return nil
}

func (b *ProposalBroadcasterImpl) resolveProjectID(ctx context.Context, documentID string) (string, error) {
	if b.documentResolver == nil {
		return "", fmt.Errorf("document resolver unavailable")
	}

	docRef, err := b.documentResolver.ResolveDocument(ctx, documentID)
	if err != nil {
		return "", err
	}

	projectUUID, err := parseUUID(strings.TrimSpace(docRef.ProjectID))
	if err != nil {
		return "", fmt.Errorf("resolved invalid project id for proposal broadcast: %w", err)
	}

	return projectUUID.String(), nil
}
