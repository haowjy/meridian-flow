package collab

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"

	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	"meridian/internal/domain/repositories"
	collabSvc "meridian/internal/domain/services/collab"
)

const defaultIdempotencyTTL = 24 * time.Hour

const maxProposalYjsUpdateBytes = 256 * 1024
const maxQueuedAIProposalsPerDocument = 200
const maxPendingAcceptOperationsPerDocument = 20

// ProposalService executes proposal lifecycle operations.
type ProposalService struct {
	proposalStore          collabSvc.ProposalStore
	idempotencyStore       collabSvc.IdempotencyStore
	txManager              repositories.TransactionManager
	runtime                collabSvc.ProposalRuntime
	autoAcceptPolicyStore  collabSvc.AutoAcceptPolicyStore
	aiContentProjector     collabSvc.AIContentProjector
	arbiter                collabSvc.AgentArbiter
	createGate             *proposalDocumentGate
	acceptGate             *proposalAcceptGate
	defaultAutoAcceptValue bool
}

// NewProposalService creates a new proposal service.
func NewProposalService(
	proposalStore collabSvc.ProposalStore,
	idempotencyStore collabSvc.IdempotencyStore,
	txManager repositories.TransactionManager,
	runtime collabSvc.ProposalRuntime,
	autoAcceptPolicyStore collabSvc.AutoAcceptPolicyStore,
	aiContentProjector collabSvc.AIContentProjector,
	arbiter collabSvc.AgentArbiter,
	defaultAutoAcceptValue bool,
) collabSvc.ProposalService {
	return &ProposalService{
		proposalStore:          proposalStore,
		idempotencyStore:       idempotencyStore,
		txManager:              txManager,
		runtime:                runtime,
		autoAcceptPolicyStore:  autoAcceptPolicyStore,
		aiContentProjector:     aiContentProjector,
		arbiter:                arbiter,
		createGate:             newProposalDocumentGate(),
		acceptGate:             newProposalAcceptGate(maxPendingAcceptOperationsPerDocument),
		defaultAutoAcceptValue: defaultAutoAcceptValue,
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
		Status:            collabModels.ProposalStatusProposed,
		YjsUpdate:         req.YjsUpdate,
		Description:       req.Description,
		CreatedByUserID:   req.CreatedByUserID,
	}

	autoAccept := s.resolveAutoAccept(req.AgentAutoAccept, nil)
	if req.AgentAutoAccept == nil {
		inputs, err := s.autoAcceptPolicyStore.GetPolicyInputs(ctx, req.DocumentID, req.CreatedByUserID)
		if err != nil {
			return nil, err
		}
		autoAccept = s.resolveAutoAccept(nil, inputs)
	}

	// Arbiter evaluation: AI proposals only. Can downgrade auto-accept -> require review.
	// Arbiter errors are non-fatal: degrade to review-required for writer safety.
	if req.Source == collabModels.ProposalSourceAI && autoAccept {
		arbiterInput := collabSvc.ArbiterInput{
			DocumentID:         req.DocumentID,
			Source:             req.Source,
			ProducerAgentType:  req.ProducerAgentType,
			YjsUpdateSize:      len(req.YjsUpdate),
			BaselineAutoAccept: autoAccept,
		}
		decision := s.evaluateArbiterSafe(ctx, arbiterInput)
		if decision.Verdict == collabSvc.ArbiterVerdictRequireReview {
			autoAccept = false
		}
		// ArbiterVerdictAllow and ArbiterVerdictPassThrough preserve the baseline.
	}

	if !autoAccept {
		if req.Source == collabModels.ProposalSourceAI {
			if err := s.createGate.WithDocument(req.DocumentID, func() error {
				return s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
					count, err := s.proposalStore.CountByDocumentAndStatusAndSource(
						txCtx,
						req.DocumentID,
						collabModels.ProposalStatusProposed,
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
					return s.createAndRecompute(txCtx, proposal, req.DocumentID)
				})
			}); err != nil {
				return nil, err
			}
			return proposal, nil
		}

		if err := s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
			return s.createAndRecompute(txCtx, proposal, req.DocumentID)
		}); err != nil {
			return nil, err
		}
		return proposal, nil
	}

	if err := s.acceptGate.WithDocument(req.DocumentID, func() error {
		return s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
			if err := s.createAndRecompute(txCtx, proposal, req.DocumentID); err != nil {
				return err
			}
			if err := s.runtime.ApplyUpdate(txCtx, proposal.DocumentID, proposal.YjsUpdate, "proposal:auto_accept"); err != nil {
				return fmt.Errorf("apply proposal auto-accept update: %w", err)
			}

			decision := collabModels.ProposalDecision{
				ProposalID:      proposal.ID,
				DecidedByUserID: req.CreatedByUserID,
				DecidedAt:       time.Now().UTC(),
			}
			if err := s.proposalStore.MarkAccepted(txCtx, decision); err != nil {
				return err
			}

			proposal.Status = collabModels.ProposalStatusAccepted
			proposal.DecidedByUserID = &req.CreatedByUserID
			proposal.DecidedAt = &decision.DecidedAt
			if err := s.aiContentProjector.Recompute(txCtx, req.DocumentID); err != nil {
				return err
			}
			return nil
		})
	}); err != nil {
		return nil, err
	}
	return proposal, nil
}

// createAndRecompute persists a proposal and recomputes the AI content projection
// in a single transactional step. Used by all CreateProposal code paths.
func (s *ProposalService) createAndRecompute(ctx context.Context, proposal *collabModels.Proposal, documentID uuid.UUID) error {
	if err := s.proposalStore.Create(ctx, proposal); err != nil {
		return err
	}
	return s.aiContentProjector.Recompute(ctx, documentID)
}

// AcceptProposal applies Yjs update + marks accepted with idempotency replay support.
func (s *ProposalService) AcceptProposal(ctx context.Context, req collabSvc.AcceptProposalRequest) (*collabSvc.AcceptProposalResult, error) {
	if err := validateIdempotencyRequest(req.IdempotencyKey, req.RequestHash); err != nil {
		return nil, err
	}

	replay, err := s.getProposalAcceptReplay(ctx, req.ProposalID, req.UserID, req.IdempotencyKey, req.RequestHash)
	if err != nil || replay != nil {
		return replay, err
	}

	proposalForLock, err := s.proposalStore.GetByID(ctx, req.ProposalID)
	if err != nil {
		return nil, err
	}

	var result *collabSvc.AcceptProposalResult
	err = s.acceptGate.WithDocument(proposalForLock.DocumentID, func() error {
		replay, err := s.getProposalAcceptReplay(ctx, req.ProposalID, req.UserID, req.IdempotencyKey, req.RequestHash)
		if err != nil || replay != nil {
			result = replay
			return err
		}

		return s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
			proposal, err := s.proposalStore.GetByID(txCtx, req.ProposalID)
			if err != nil {
				return err
			}
			if proposal.Status != collabModels.ProposalStatusProposed {
				return domain.NewValidationError(
					fmt.Sprintf("proposal %s is %s and cannot be accepted", proposal.ID, proposal.Status),
				)
			}

			// Apply runtime update before MarkAccepted. If MarkAccepted fails, retry is safe because
			// Yjs updates are idempotent: re-applying the same update does not change document state.
			if err := s.runtime.ApplyUpdate(txCtx, proposal.DocumentID, proposal.YjsUpdate, req.TransactionOrigin); err != nil {
				return fmt.Errorf("apply proposal update: %w", err)
			}

			decision := collabModels.ProposalDecision{
				ProposalID:      proposal.ID,
				DecidedByUserID: req.UserID,
				DecidedAt:       time.Now().UTC(),
			}
			if err := s.proposalStore.MarkAccepted(txCtx, decision); err != nil {
				return err
			}
			if err := s.aiContentProjector.Recompute(txCtx, proposal.DocumentID); err != nil {
				return err
			}

			payload := collabModels.ProposalAcceptResponsePayload{ProposalID: proposal.ID}
			payloadBytes, err := json.Marshal(payload)
			if err != nil {
				return fmt.Errorf("marshal proposal accept payload: %w", err)
			}

			record := &collabModels.IdempotencyRecord{
				UserID:          req.UserID,
				IdempotencyKey:  req.IdempotencyKey,
				RequestScope:    collabModels.IdempotencyScopeProposalAccept,
				ScopeID:         proposal.ID,
				RequestHash:     req.RequestHash,
				DocumentID:      proposal.DocumentID,
				ResponsePayload: payloadBytes,
				ExpiresAt:       buildIdempotencyExpiresAt(req.IdempotencyTTL),
			}
			if err := s.idempotencyStore.Create(txCtx, record); err != nil {
				return err
			}

			result = &collabSvc.AcceptProposalResult{
				Payload:  payload,
				IsReplay: false,
				Mutations: []collabSvc.ProposalMutationIntent{
					{
						DocumentID: proposal.DocumentID,
						ProposalID: proposal.ID,
						Status:     collabModels.ProposalStatusAccepted,
						YjsUpdate:  proposal.YjsUpdate,
					},
				},
			}
			return nil
		})
	})
	if err != nil {
		if isIdempotencyConflict(err) {
			return s.getProposalAcceptReplay(ctx, req.ProposalID, req.UserID, req.IdempotencyKey, req.RequestHash)
		}
		return nil, err
	}

	return result, nil
}

// RejectProposal marks a proposal as rejected. Repeated reject is treated as idempotent success.
func (s *ProposalService) RejectProposal(ctx context.Context, req collabSvc.RejectProposalRequest) (*collabSvc.RejectProposalResult, error) {
	result := &collabSvc.RejectProposalResult{
		Noop:      false,
		Mutations: []collabSvc.ProposalMutationIntent{},
	}

	err := s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		proposal, err := s.proposalStore.GetByID(txCtx, req.ProposalID)
		if err != nil {
			return err
		}

		switch proposal.Status {
		case collabModels.ProposalStatusRejected:
			result.Noop = true
			return nil
		case collabModels.ProposalStatusAccepted:
			return domain.NewValidationError(
				fmt.Sprintf("proposal %s is %s and cannot be rejected", proposal.ID, proposal.Status),
			)
		case collabModels.ProposalStatusProposed:
			decision := collabModels.ProposalDecision{
				ProposalID:      proposal.ID,
				DecidedByUserID: req.UserID,
				DecidedAt:       time.Now().UTC(),
			}
			if err := s.proposalStore.MarkRejected(txCtx, decision); err != nil {
				return err
			}
			if err := s.aiContentProjector.Recompute(txCtx, proposal.DocumentID); err != nil {
				return err
			}
			result.Mutations = append(result.Mutations, collabSvc.ProposalMutationIntent{
				DocumentID: proposal.DocumentID,
				ProposalID: proposal.ID,
				Status:     collabModels.ProposalStatusRejected,
			})
			return nil
		default:
			return domain.NewValidationError(
				fmt.Sprintf("proposal %s has unsupported status %s", proposal.ID, proposal.Status),
			)
		}
	})
	if err != nil {
		return nil, err
	}

	return result, nil
}

// GroupAccept accepts all currently-proposed rows in a group in deterministic order.
func (s *ProposalService) GroupAccept(ctx context.Context, req collabSvc.GroupAcceptRequest) (*collabSvc.GroupAcceptResult, error) {
	if err := validateIdempotencyRequest(req.IdempotencyKey, req.RequestHash); err != nil {
		return nil, err
	}

	replay, err := s.getGroupAcceptReplay(ctx, req.ProposalGroupID, req.UserID, req.IdempotencyKey, req.RequestHash)
	if err != nil || replay != nil {
		return replay, err
	}

	var result *collabSvc.GroupAcceptResult
	err = s.acceptGate.WithDocument(req.DocumentID, func() error {
		replay, err := s.getGroupAcceptReplay(ctx, req.ProposalGroupID, req.UserID, req.IdempotencyKey, req.RequestHash)
		if err != nil || replay != nil {
			result = replay
			return err
		}

		return s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
			proposedStatus := collabModels.ProposalStatusProposed
			proposals, err := s.proposalStore.ListByGroup(txCtx, req.ProposalGroupID, &proposedStatus)
			if err != nil {
				return err
			}

			outcomes := make([]collabModels.GroupAcceptOutcome, 0, len(proposals))
			mutations := make([]collabSvc.ProposalMutationIntent, 0, len(proposals))
			var hadAcceptedMutation bool

			// First pass: validate and collect proposals with matching document ID.
			var validProposals []groupAcceptValidProposal

			for _, proposal := range proposals {
				if proposal.DocumentID != req.DocumentID {
					msg := fmt.Sprintf(
						"proposal document mismatch: expected %s, got %s",
						req.DocumentID,
						proposal.DocumentID,
					)
					outcomes = append(outcomes, collabModels.GroupAcceptOutcome{
						ProposalID: proposal.ID,
						Status:     collabModels.GroupAcceptOutcomeStatusSkipped,
						Error:      &msg,
					})
					continue
				}
				idx := len(outcomes)
				outcomes = append(outcomes, collabModels.GroupAcceptOutcome{}) // placeholder
				validProposals = append(validProposals, groupAcceptValidProposal{proposal: proposal, index: idx})
			}

			// Compose all valid proposals into a single composite Yjs update and apply once.
			// This avoids subtle CRDT composition issues from applying updates individually.
			if len(validProposals) > 0 {
				// Get current base state to build composite update
				baseState, err := s.runtime.GetCurrentState(txCtx, req.DocumentID)
				if err != nil {
					return fmt.Errorf("get current state for composite: %w", err)
				}

				// Build composite in a temp doc (same pattern as buildProjectedDoc)
				compositeUpdate, applyErrors, err := composeProposalUpdates(baseState, validProposals)
				if err != nil {
					return fmt.Errorf("compose proposal updates: %w", err)
				}

				// Handle individual apply errors (from composition)
				for i, vp := range validProposals {
					if applyErrors[i] != nil {
						msg := fmt.Sprintf("apply failed: %v", applyErrors[i])
						outcomes[vp.index] = collabModels.GroupAcceptOutcome{
							ProposalID: vp.proposal.ID,
							Status:     collabModels.GroupAcceptOutcomeStatusSkipped,
							Error:      &msg,
						}
					}
				}

				// Apply the composite update once to the live runtime
				if compositeUpdate != nil {
					if err := s.runtime.ApplyUpdate(txCtx, req.DocumentID, compositeUpdate, req.TransactionOrigin); err != nil {
						return fmt.Errorf("apply composite update: %w", err)
					}
				}

				// Mark accepted and build mutations
				for i, vp := range validProposals {
					if applyErrors[i] != nil {
						continue
					}

					decision := collabModels.ProposalDecision{
						ProposalID:      vp.proposal.ID,
						DecidedByUserID: req.UserID,
						DecidedAt:       time.Now().UTC(),
					}
					if err := s.proposalStore.MarkAccepted(txCtx, decision); err != nil {
						var validationErr *domain.ValidationError
						if errors.As(err, &validationErr) {
							msg := fmt.Sprintf("mark accepted failed: %v", err)
							outcomes[vp.index] = collabModels.GroupAcceptOutcome{
								ProposalID: vp.proposal.ID,
								Status:     collabModels.GroupAcceptOutcomeStatusSkipped,
								Error:      &msg,
							}
							continue
						}
						return fmt.Errorf("mark proposal accepted: %w", err)
					}

					outcomes[vp.index] = collabModels.GroupAcceptOutcome{
						ProposalID: vp.proposal.ID,
						Status:     collabModels.GroupAcceptOutcomeStatusAccepted,
					}
					hadAcceptedMutation = true
					mutations = append(mutations, collabSvc.ProposalMutationIntent{
						DocumentID: vp.proposal.DocumentID,
						ProposalID: vp.proposal.ID,
						Status:     collabModels.ProposalStatusAccepted,
						YjsUpdate:  vp.proposal.YjsUpdate,
					})
				}
			}

			if hadAcceptedMutation {
				if err := s.aiContentProjector.Recompute(txCtx, req.DocumentID); err != nil {
					return err
				}
			}

			payload := collabModels.GroupAcceptResponsePayload{Outcomes: outcomes}
			payloadBytes, err := json.Marshal(payload)
			if err != nil {
				return fmt.Errorf("marshal group accept payload: %w", err)
			}

			record := &collabModels.IdempotencyRecord{
				UserID:          req.UserID,
				IdempotencyKey:  req.IdempotencyKey,
				RequestScope:    collabModels.IdempotencyScopeGroupAccept,
				ScopeID:         req.ProposalGroupID,
				RequestHash:     req.RequestHash,
				DocumentID:      req.DocumentID,
				ResponsePayload: payloadBytes,
				ExpiresAt:       buildIdempotencyExpiresAt(req.IdempotencyTTL),
			}
			if err := s.idempotencyStore.Create(txCtx, record); err != nil {
				return err
			}

			result = &collabSvc.GroupAcceptResult{
				Payload:   payload,
				IsReplay:  false,
				Mutations: mutations,
			}
			return nil
		})
	})
	if err != nil {
		if isIdempotencyConflict(err) {
			return s.getGroupAcceptReplay(ctx, req.ProposalGroupID, req.UserID, req.IdempotencyKey, req.RequestHash)
		}
		return nil, err
	}

	return result, nil
}

// groupAcceptValidProposal pairs a proposal with its position in the outcomes slice.
type groupAcceptValidProposal struct {
	proposal collabModels.Proposal
	index    int // position in outcomes slice
}

// composeProposalUpdates applies proposal updates sequentially to a temp Y.Doc
// and returns a single composite update encoding the combined result.
// Returns per-proposal error slice (nil for successful applications).
// The temp doc approach mirrors buildProjectedDoc and is provably safe.
func composeProposalUpdates(baseState []byte, proposals []groupAcceptValidProposal) (compositeUpdate []byte, perError []error, err error) {
	perError = make([]error, len(proposals))

	tempDoc := ycrdt.NewDoc("group-accept-composite", true, ycrdt.DefaultGCFilter, nil, false)
	if len(baseState) > 0 {
		if err := safeApplyUpdate(tempDoc, baseState, "group-accept-base"); err != nil {
			return nil, perError, fmt.Errorf("apply base state to temp doc: %w", err)
		}
	}

	// Capture base state vector before applying proposals
	baseStateVector := ycrdt.EncodeStateVector(tempDoc, nil, ycrdt.NewUpdateEncoderV1())

	anyApplied := false
	for i, vp := range proposals {
		if applyErr := safeApplyUpdate(tempDoc, vp.proposal.YjsUpdate, "group-accept-proposal"); applyErr != nil {
			perError[i] = applyErr
			continue
		}
		anyApplied = true
	}

	if !anyApplied {
		return nil, perError, nil
	}

	// Encode only the delta (proposals' changes relative to base)
	composite, encErr := func() (state []byte, err error) {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("encode composite state panic: %v", r)
			}
		}()
		return ycrdt.EncodeStateAsUpdate(tempDoc, baseStateVector), nil
	}()
	if encErr != nil {
		return nil, perError, encErr
	}

	return composite, perError, nil
}

