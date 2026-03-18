package collab

import (
	"context"
	"fmt"
	"sort"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"

	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
)

const proposalProjectorPageSize = 200

// ProjectedStateBuilderService builds per-user projected state for proposal creation.
type ProjectedStateBuilderService struct {
	stateStore      collabSvc.DocumentStateStore
	proposalStore   collabSvc.ProposalStore
	proposalRuntime collabSvc.ProposalRuntime
	contentLoader   collabSvc.DocumentContentLoader
}

// NewProjectedStateBuilder creates a projected-state builder.
func NewProjectedStateBuilder(
	stateStore collabSvc.DocumentStateStore,
	proposalStore collabSvc.ProposalStore,
	proposalRuntime collabSvc.ProposalRuntime,
	contentLoader collabSvc.DocumentContentLoader,
) *ProjectedStateBuilderService {
	return &ProjectedStateBuilderService{
		stateStore:      stateStore,
		proposalStore:   proposalStore,
		proposalRuntime: proposalRuntime,
		contentLoader:   contentLoader,
	}
}

// loadBaseState returns the authoritative base Yjs state bytes for a document.
// Prefers the in-memory runtime snapshot; falls back to persisted state.
func (p *ProjectedStateBuilderService) loadBaseState(ctx context.Context, documentID uuid.UUID) ([]byte, error) {
	baseState, found, err := p.proposalRuntime.GetStateSnapshot(ctx, documentID)
	if err != nil {
		return nil, fmt.Errorf("get in-memory collab state snapshot: %w", err)
	}
	if !found {
		baseState, err = p.stateStore.LoadState(ctx, documentID.String())
		if err != nil {
			return nil, fmt.Errorf("load persisted collab state: %w", err)
		}
	}
	return baseState, nil
}

// BuildProjectedState returns Yjs state bytes representing base + pending proposals.
// Handles bootstrap: if yjs_state is empty, initializes from document markdown content
// (same pattern as session_manager.go:loadState). Persists bootstrapped state so
// subsequent CRDT updates share ancestry with the canonical base.
func (p *ProjectedStateBuilderService) BuildProjectedState(
	ctx context.Context,
	documentID uuid.UUID,
	userID uuid.UUID,
) ([]byte, error) {
	baseState, err := p.loadBaseState(ctx, documentID)
	if err != nil {
		return nil, err
	}

	// Bootstrap: if no yjs_state exists (document created via REST API or seeding),
	// initialize from markdown content. Without this, TextToUpdate panics on nil Y.Text.
	bootstrapped := false
	if len(baseState) == 0 {
		baseState, err = p.bootstrapFromContent(ctx, documentID)
		if err != nil {
			return nil, fmt.Errorf("bootstrap from content: %w", err)
		}
		bootstrapped = true
	}

	pendingProposals, err := p.listPendingProposalsForUser(ctx, documentID, userID)
	if err != nil {
		return nil, err
	}

	_, projectedDoc, err := buildProjectedDoc(baseState, pendingProposals)
	if err != nil {
		return nil, err
	}

	projectedState, err := safeEncodeStateAsUpdate(projectedDoc)
	if err != nil {
		return nil, fmt.Errorf("encode projected state: %w", err)
	}

	// Persist bootstrapped state to establish CRDT lineage. Without this,
	// updates generated against the bootstrapped doc become no-ops when
	// later applied to an empty persisted state.
	if bootstrapped {
		baseDoc := ycrdt.NewDoc("bootstrap-persist", true, ycrdt.DefaultGCFilter, nil, false)
		if len(baseState) > 0 {
			if err := safeApplyUpdate(baseDoc, baseState, "bootstrap-persist"); err != nil {
				return nil, fmt.Errorf("decode bootstrapped base for persist: %w", err)
			}
		}

		// Keep canonical bootstrap aligned with phase-2 map expectations.
		baseDoc.GetMap("_proposal_status")

		content := ""
		if yText := baseDoc.GetText("content"); yText != nil {
			content = yText.ToString()
		}
		nextBaseState, encodeErr := safeEncodeStateAsUpdate(baseDoc)
		if encodeErr != nil {
			return nil, fmt.Errorf("encode bootstrapped state for persist: %w", encodeErr)
		}
		if saveErr := p.stateStore.SaveState(ctx, documentID.String(), nextBaseState, content); saveErr != nil {
			return nil, fmt.Errorf("persist bootstrapped yjs state: %w", saveErr)
		}
	}

	return projectedState, nil
}

// bootstrapFromContent creates initial Yjs state from document markdown content.
// Returns valid (possibly empty) Y.Doc state bytes. Same pattern as session_manager.go:loadState.
func (p *ProjectedStateBuilderService) bootstrapFromContent(ctx context.Context, documentID uuid.UUID) ([]byte, error) {
	content, err := p.contentLoader.LoadContentForBootstrap(ctx, documentID.String())
	if err != nil {
		return nil, fmt.Errorf("load bootstrap content: %w", err)
	}

	doc := ycrdt.NewDoc(documentID.String(), true, ycrdt.DefaultGCFilter, nil, false)
	doc.GetMap("_proposal_status")
	if content != "" {
		yText := doc.GetText("content")
		if yText != nil {
			doc.Transact(func(_ *ycrdt.Transaction) {
				yText.Insert(0, content, nil)
			}, "server-bootstrap")
		}
	}

	state, err := safeEncodeStateAsUpdate(doc)
	if err != nil {
		return nil, fmt.Errorf("encode bootstrapped state: %w", err)
	}
	return state, nil
}

// buildProjectedDoc creates a base Y.Doc and a projected Y.Doc (base + proposals).
func buildProjectedDoc(baseState []byte, proposals []collabModels.Proposal) (*ycrdt.Doc, *ycrdt.Doc, error) {
	baseDoc := ycrdt.NewDoc("base", true, ycrdt.DefaultGCFilter, nil, false)
	if len(baseState) > 0 {
		if err := safeApplyUpdate(baseDoc, baseState, "projected-state-base"); err != nil {
			return nil, nil, fmt.Errorf("apply base state: %w", err)
		}
	}

	projectedDoc := ycrdt.NewDoc("projected", true, ycrdt.DefaultGCFilter, nil, false)
	clonedBaseState, err := safeEncodeStateAsUpdate(baseDoc)
	if err != nil {
		return nil, nil, fmt.Errorf("clone base state: %w", err)
	}
	if len(clonedBaseState) > 0 {
		if err := safeApplyUpdate(projectedDoc, clonedBaseState, "projected-state-clone"); err != nil {
			return nil, nil, fmt.Errorf("apply cloned base state: %w", err)
		}
	}

	for _, proposal := range proposals {
		if err := safeApplyUpdate(projectedDoc, proposal.YjsUpdate, "projected-state-proposal"); err != nil {
			return nil, nil, fmt.Errorf("apply pending proposal %s: %w", proposal.ID, err)
		}
	}

	return baseDoc, projectedDoc, nil
}

func (p *ProjectedStateBuilderService) listPendingProposalsForUser(
	ctx context.Context,
	documentID uuid.UUID,
	userID uuid.UUID,
) ([]collabModels.Proposal, error) {
	pendingStatus := collabModels.ProposalStatusPending
	offset := 0
	proposals := make([]collabModels.Proposal, 0, proposalProjectorPageSize)

	for {
		batch, err := p.proposalStore.ListByDocument(ctx, documentID, &pendingStatus, proposalProjectorPageSize, offset)
		if err != nil {
			return nil, fmt.Errorf("list pending proposals: %w", err)
		}
		proposals = append(proposals, batch...)
		if len(batch) < proposalProjectorPageSize {
			break
		}
		offset += len(batch)
	}

	userProposals := make([]collabModels.Proposal, 0, len(proposals))
	for _, proposal := range proposals {
		if proposal.CreatedByUserID == userID {
			userProposals = append(userProposals, proposal)
		}
	}

	sort.SliceStable(userProposals, func(i, j int) bool {
		if userProposals[i].CreatedAt.Equal(userProposals[j].CreatedAt) {
			return userProposals[i].ID.String() < userProposals[j].ID.String()
		}
		return userProposals[i].CreatedAt.Before(userProposals[j].CreatedAt)
	})

	return userProposals, nil
}
