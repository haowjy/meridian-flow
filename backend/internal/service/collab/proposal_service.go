package collab

import (
	"context"
	"fmt"

	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	"meridian/internal/domain/repositories"
	collabSvc "meridian/internal/domain/services/collab"
)

const maxProposalYjsUpdateBytes = 256 * 1024
const maxQueuedAIProposalsPerDocument = 200

// ProposalService executes proposal lifecycle operations.
type ProposalService struct {
	proposalStore   collabSvc.ProposalStore
	txManager       repositories.TransactionManager
	runtime         collabSvc.ProposalRuntime
	createGate      *proposalDocumentGate
	ownerTabTracker collabSvc.OwnerTabPresenceTracker
}

// NewProposalService creates a new proposal service.
func NewProposalService(
	proposalStore collabSvc.ProposalStore,
	txManager repositories.TransactionManager,
	runtime collabSvc.ProposalRuntime,
	ownerTabTracker collabSvc.OwnerTabPresenceTracker,
) collabSvc.ProposalService {
	return &ProposalService{
		proposalStore:   proposalStore,
		txManager:       txManager,
		runtime:         runtime,
		createGate:      newProposalDocumentGate(),
		ownerTabTracker: ownerTabTracker,
	}
}

// CreateProposal persists a new proposal row.
func (s *ProposalService) CreateProposal(ctx context.Context, req collabSvc.CreateProposalRequest) (*collabModels.Proposal, error) {
	if len(req.YjsUpdate) == 0 {
		return nil, domain.NewValidationErrorWithField("proposal yjs_update is required", "yjs_update")
	}
	if len(req.YjsUpdate) > maxProposalYjsUpdateBytes {
		return nil, domain.NewValidationErrorWithField(
			fmt.Sprintf("proposal yjs_update exceeds maximum size of %d bytes", maxProposalYjsUpdateBytes),
			"yjs_update",
		)
	}

	proposal := &collabModels.Proposal{
		DocumentID:        req.DocumentID,
		Source:            req.Source,
		ProducerAgentType: req.ProducerAgentType,
		ThreadID:          req.ThreadID,
		TurnID:            req.TurnID,
		AgentRunID:        req.AgentRunID,
		ProposalGroupID:   req.ProposalGroupID,
		Status:            collabModels.ProposalStatusPending,
		YjsUpdate:         req.YjsUpdate,
		Description:       req.Description,
		RegionTextBefore:  req.RegionTextBefore,
		RegionTextAfter:   req.RegionTextAfter,
		ProposedAtOffset:  req.ProposedAtOffset,
		CreatedByUserID:   req.CreatedByUserID,
	}

	canonicalState, err := s.runtime.GetCurrentState(ctx, req.DocumentID)
	if err != nil {
		return nil, fmt.Errorf("load canonical state for yjs validation: %w", err)
	}
	if err := ValidateYjsUpdate(canonicalState, req.YjsUpdate); err != nil {
		proposal.Status = collabModels.ProposalStatusInvalid
		if txErr := s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
			return s.createProposal(txCtx, proposal)
		}); txErr != nil {
			return nil, txErr
		}
		return proposal, nil
	}

	hasOwnerTabs := s.ownerTabTracker != nil && s.ownerTabTracker.HasOwnerTabs(req.DocumentID)

	persistFn := func(txCtx context.Context) error {
		if req.Source == collabModels.ProposalSourceAI && req.TurnID != nil {
			count, err := s.proposalStore.CountByDocumentAndTurnID(txCtx, req.DocumentID, *req.TurnID)
			if err != nil {
				return fmt.Errorf("count turn proposals for ai_turn bookmark: %w", err)
			}
			if count == 0 {
				if err := s.runtime.CreateAITurnBookmark(txCtx, req.DocumentID, *req.TurnID); err != nil {
					return fmt.Errorf("create ai_turn bookmark before first turn proposal: %w", err)
				}
			}
		}

		if err := s.createProposal(txCtx, proposal); err != nil {
			return err
		}
		if hasOwnerTabs {
			return nil
		}
		return s.applyBackendFallbackAccept(txCtx, proposal)
	}

	if req.Source == collabModels.ProposalSourceAI && hasOwnerTabs {
		if err := s.createGate.WithDocument(req.DocumentID, func() error {
			return s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
				count, err := s.proposalStore.CountByDocumentAndStatusAndSource(
					txCtx,
					req.DocumentID,
					collabModels.ProposalStatusPending,
					collabModels.ProposalSourceAI,
				)
				if err != nil {
					return err
				}
				if count >= maxQueuedAIProposalsPerDocument {
					return domain.NewRateLimitError(
						fmt.Sprintf(
							"document %s has reached the queued AI proposal limit (%d)",
							req.DocumentID,
							maxQueuedAIProposalsPerDocument,
						),
					)
				}
				return persistFn(txCtx)
			})
		}); err != nil {
			return nil, err
		}
		return proposal, nil
	}

	if err := s.txManager.ExecTx(ctx, persistFn); err != nil {
		return nil, err
	}
	return proposal, nil
}

func (s *ProposalService) createProposal(ctx context.Context, proposal *collabModels.Proposal) error {
	if err := s.proposalStore.Create(ctx, proposal); err != nil {
		return err
	}
	return nil
}

func (s *ProposalService) applyBackendFallbackAccept(
	ctx context.Context,
	proposal *collabModels.Proposal,
) error {
	if err := s.runtime.ApplyUpdate(ctx, proposal.DocumentID, proposal.YjsUpdate, "proposal:backend_fallback_apply"); err != nil {
		return fmt.Errorf("apply backend fallback proposal update: %w", err)
	}

	statusUpdate, err := buildProposalAcceptedStatusUpdate(proposal.ID)
	if err != nil {
		return fmt.Errorf("build backend fallback status update: %w", err)
	}
	if err := s.runtime.ApplyUpdate(ctx, proposal.DocumentID, statusUpdate, "proposal:backend_fallback_apply"); err != nil {
		return fmt.Errorf("apply backend fallback status update: %w", err)
	}

	if err := s.proposalStore.UpsertStatus(ctx, proposal.ID, collabModels.ProposalStatusAccepted); err != nil {
		return fmt.Errorf("persist backend fallback accepted status: %w", err)
	}

	proposal.Status = collabModels.ProposalStatusAccepted
	return nil
}
