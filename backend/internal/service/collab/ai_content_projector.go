package collab

import (
	"context"
	"fmt"
	"sort"

	"github.com/google/uuid"
	ycrdt "github.com/skyterra/y-crdt"

	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
)

const proposalProjectorPageSize = 200

// AIContentProjector recomputes ai_content from base document state + pending proposals.
type AIContentProjector struct {
	documentStore   collabSvc.DocumentStore
	proposalStore   collabSvc.ProposalStore
	proposalRuntime collabSvc.ProposalRuntime
}

func NewAIContentProjector(
	documentStore collabSvc.DocumentStore,
	proposalStore collabSvc.ProposalStore,
	proposalRuntime collabSvc.ProposalRuntime,
) collabSvc.AIContentProjector {
	return &AIContentProjector{
		documentStore:   documentStore,
		proposalStore:   proposalStore,
		proposalRuntime: proposalRuntime,
	}
}

func (p *AIContentProjector) Recompute(ctx context.Context, documentID uuid.UUID) error {
	baseState, found, err := p.proposalRuntime.GetStateSnapshot(ctx, documentID)
	if err != nil {
		return fmt.Errorf("get in-memory collab state snapshot: %w", err)
	}
	if !found {
		baseState, err = p.documentStore.LoadState(ctx, documentID.String())
		if err != nil {
			return fmt.Errorf("load persisted collab state: %w", err)
		}
	}

	baseDoc := ycrdt.NewDoc(documentID.String(), true, ycrdt.DefaultGCFilter, nil, false)
	if len(baseState) > 0 {
		if err := safeApplyUpdate(baseDoc, baseState, "ai-content-base"); err != nil {
			return fmt.Errorf("apply base state: %w", err)
		}
	}

	projectedDoc := ycrdt.NewDoc(documentID.String(), true, ycrdt.DefaultGCFilter, nil, false)
	clonedBaseState, err := safeEncodeStateAsUpdate(baseDoc)
	if err != nil {
		return fmt.Errorf("clone base state: %w", err)
	}
	if len(clonedBaseState) > 0 {
		if err := safeApplyUpdate(projectedDoc, clonedBaseState, "ai-content-clone"); err != nil {
			return fmt.Errorf("apply cloned base state: %w", err)
		}
	}

	pendingProposals, err := p.listPendingProposals(ctx, documentID)
	if err != nil {
		return err
	}
	for _, proposal := range pendingProposals {
		if err := safeApplyUpdate(projectedDoc, proposal.YjsUpdate, "ai-content-proposal"); err != nil {
			return fmt.Errorf("apply pending proposal %s: %w", proposal.ID, err)
		}
	}

	nextBaseState, err := safeEncodeStateAsUpdate(baseDoc)
	if err != nil {
		return fmt.Errorf("encode base state: %w", err)
	}

	baseContent := ""
	if yText := baseDoc.GetText("content"); yText != nil {
		baseContent = yText.ToString()
	}

	aiContent := ""
	if yText := projectedDoc.GetText("content"); yText != nil {
		aiContent = yText.ToString()
	}

	if err := p.documentStore.SaveState(ctx, documentID.String(), nextBaseState, baseContent, aiContent); err != nil {
		return fmt.Errorf("save recomputed ai content: %w", err)
	}

	return nil
}

func (p *AIContentProjector) listPendingProposals(ctx context.Context, documentID uuid.UUID) ([]collabModels.Proposal, error) {
	proposedStatus := collabModels.ProposalStatusProposed
	offset := 0
	proposals := make([]collabModels.Proposal, 0, proposalProjectorPageSize)

	for {
		batch, err := p.proposalStore.ListByDocument(ctx, documentID, &proposedStatus, proposalProjectorPageSize, offset)
		if err != nil {
			return nil, fmt.Errorf("list pending proposals: %w", err)
		}
		proposals = append(proposals, batch...)
		if len(batch) < proposalProjectorPageSize {
			break
		}
		offset += len(batch)
	}

	sort.SliceStable(proposals, func(i, j int) bool {
		if proposals[i].CreatedAt.Equal(proposals[j].CreatedAt) {
			return proposals[i].ID.String() < proposals[j].ID.String()
		}
		return proposals[i].CreatedAt.Before(proposals[j].CreatedAt)
	})

	return proposals, nil
}
