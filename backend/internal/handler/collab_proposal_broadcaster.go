package handler

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	collab "meridian/internal/domain/collab"
)

// ProposalBroadcasterImpl implements tools.ProposalBroadcaster by routing
// proposal invalidation notifications to project doc websocket connections and
// Yjs frames to document websocket connections.
type ProposalBroadcasterImpl struct {
	docNotifier        DocNotifier
	docSyncBroadcaster DocumentSyncBroadcaster
	documentResolver   collab.DocumentResolver
}

// NewProposalBroadcasterImpl creates a broadcaster backed by doc WS notifications and document WS fanout.
func NewProposalBroadcasterImpl(
	docNotifier DocNotifier,
	docSyncBroadcaster DocumentSyncBroadcaster,
	documentResolver collab.DocumentResolver,
) *ProposalBroadcasterImpl {
	return &ProposalBroadcasterImpl{
		docNotifier:        docNotifier,
		docSyncBroadcaster: docSyncBroadcaster,
		documentResolver:   documentResolver,
	}
}

// BroadcastProposalCreated sends a proposal invalidate event to all project doc WS connections.
func (b *ProposalBroadcasterImpl) BroadcastProposalCreated(documentID string, proposal *collab.Proposal) error {
	if proposal == nil {
		return fmt.Errorf("proposal is required for proposal broadcast")
	}

	documentUUID, err := parseUUID(documentID)
	if err != nil {
		return fmt.Errorf("invalid document id for proposal broadcast: %w", err)
	}
	canonicalDocumentID := documentUUID.String()

	projectID, err := b.resolveProjectID(context.Background(), canonicalDocumentID)
	if err != nil {
		return err
	}

	if b.docNotifier != nil {
		b.docNotifier.NotifyProposal(projectID, proposal.ID.String(), "created", canonicalDocumentID)
	}
	return nil
}

// BroadcastProposalAccepted sends an accepted proposal invalidate event and a Yjs update frame.
func (b *ProposalBroadcasterImpl) BroadcastProposalAccepted(documentID string, proposalID uuid.UUID, yjsUpdate []byte) error {
	documentUUID, err := parseUUID(documentID)
	if err != nil {
		return fmt.Errorf("invalid document id for proposal broadcast: %w", err)
	}
	canonicalDocumentID := documentUUID.String()

	projectID, err := b.resolveProjectID(context.Background(), canonicalDocumentID)
	if err != nil {
		return err
	}
	if b.docNotifier != nil {
		b.docNotifier.NotifyProposal(projectID, proposalID.String(), "accepted", canonicalDocumentID)
	}

	if len(yjsUpdate) > 0 && b.docSyncBroadcaster != nil {
		b.docSyncBroadcaster.BroadcastYjsUpdate(canonicalDocumentID, yjsUpdate)
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
