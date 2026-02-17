package collab

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

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

	// Arbiter evaluation: AI proposals only. Can downgrade auto-accept → require review.
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

					if err := s.proposalStore.Create(txCtx, proposal); err != nil {
						return err
					}
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

		if err := s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
			if err := s.proposalStore.Create(txCtx, proposal); err != nil {
				return err
			}
			if err := s.aiContentProjector.Recompute(txCtx, req.DocumentID); err != nil {
				return err
			}
			return nil
		}); err != nil {
			return nil, err
		}
		return proposal, nil
	}

	if err := s.acceptGate.WithDocument(req.DocumentID, func() error {
		return s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
			if err := s.proposalStore.Create(txCtx, proposal); err != nil {
				return err
			}
			if err := s.aiContentProjector.Recompute(txCtx, req.DocumentID); err != nil {
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

				// Apply runtime update before MarkAccepted. If MarkAccepted fails, retry is safe because
				// Yjs updates are idempotent: re-applying the same update does not change document state.
				if err := s.runtime.ApplyUpdate(txCtx, proposal.DocumentID, proposal.YjsUpdate, req.TransactionOrigin); err != nil {
					var validationErr *domain.ValidationError
					if errors.As(err, &validationErr) {
						msg := fmt.Sprintf("apply failed: %v", err)
						outcomes = append(outcomes, collabModels.GroupAcceptOutcome{
							ProposalID: proposal.ID,
							Status:     collabModels.GroupAcceptOutcomeStatusSkipped,
							Error:      &msg,
						})
						continue
					}
					return fmt.Errorf("apply proposal update: %w", err)
				}

				decision := collabModels.ProposalDecision{
					ProposalID:      proposal.ID,
					DecidedByUserID: req.UserID,
					DecidedAt:       time.Now().UTC(),
				}
				if err := s.proposalStore.MarkAccepted(txCtx, decision); err != nil {
					var validationErr *domain.ValidationError
					if errors.As(err, &validationErr) {
						msg := fmt.Sprintf("mark accepted failed: %v", err)
						outcomes = append(outcomes, collabModels.GroupAcceptOutcome{
							ProposalID: proposal.ID,
							Status:     collabModels.GroupAcceptOutcomeStatusSkipped,
							Error:      &msg,
						})
						continue
					}
					return fmt.Errorf("mark proposal accepted: %w", err)
				}

				outcomes = append(outcomes, collabModels.GroupAcceptOutcome{
					ProposalID: proposal.ID,
					Status:     collabModels.GroupAcceptOutcomeStatusAccepted,
				})
				hadAcceptedMutation = true
				mutations = append(mutations, collabSvc.ProposalMutationIntent{
					DocumentID: proposal.DocumentID,
					ProposalID: proposal.ID,
					Status:     collabModels.ProposalStatusAccepted,
					YjsUpdate:  proposal.YjsUpdate,
				})
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

func (s *ProposalService) getProposalAcceptReplay(
	ctx context.Context,
	proposalID uuid.UUID,
	userID uuid.UUID,
	idempotencyKey string,
	requestHash string,
) (*collabSvc.AcceptProposalResult, error) {
	record, err := s.idempotencyStore.GetByUserAndKey(ctx, userID, idempotencyKey)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return nil, nil
	}
	if record.RequestHash != requestHash {
		return nil, buildIdempotencyConflictError(idempotencyKey)
	}
	if record.RequestScope != collabModels.IdempotencyScopeProposalAccept || record.ScopeID != proposalID {
		return nil, buildIdempotencyConflictError(idempotencyKey)
	}

	var payload collabModels.ProposalAcceptResponsePayload
	if err := json.Unmarshal(record.ResponsePayload, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal proposal accept replay payload: %w", err)
	}
	return &collabSvc.AcceptProposalResult{
		Payload:   payload,
		IsReplay:  true,
		Mutations: []collabSvc.ProposalMutationIntent{},
	}, nil
}

func (s *ProposalService) getGroupAcceptReplay(
	ctx context.Context,
	groupID uuid.UUID,
	userID uuid.UUID,
	idempotencyKey string,
	requestHash string,
) (*collabSvc.GroupAcceptResult, error) {
	record, err := s.idempotencyStore.GetByUserAndKey(ctx, userID, idempotencyKey)
	if err != nil {
		return nil, err
	}
	if record == nil {
		return nil, nil
	}
	if record.RequestHash != requestHash {
		return nil, buildIdempotencyConflictError(idempotencyKey)
	}
	if record.RequestScope != collabModels.IdempotencyScopeGroupAccept || record.ScopeID != groupID {
		return nil, buildIdempotencyConflictError(idempotencyKey)
	}

	var payload collabModels.GroupAcceptResponsePayload
	if err := json.Unmarshal(record.ResponsePayload, &payload); err != nil {
		return nil, fmt.Errorf("unmarshal group accept replay payload: %w", err)
	}
	return &collabSvc.GroupAcceptResult{
		Payload:   payload,
		IsReplay:  true,
		Mutations: []collabSvc.ProposalMutationIntent{},
	}, nil
}

func validateIdempotencyRequest(idempotencyKey, requestHash string) error {
	if idempotencyKey == "" {
		return domain.NewValidationErrorWithField("idempotency key is required", "idempotency_key")
	}
	if requestHash == "" {
		return domain.NewValidationErrorWithField("request hash is required", "request_hash")
	}
	return nil
}

func buildIdempotencyConflictError(idempotencyKey string) error {
	return domain.NewConflictError(
		"idempotency_key",
		idempotencyKey,
		fmt.Sprintf("idempotency key %q conflicts with a different request payload", idempotencyKey),
	)
}

func buildIdempotencyExpiresAt(ttl time.Duration) time.Time {
	if ttl <= 0 {
		ttl = defaultIdempotencyTTL
	}
	return time.Now().UTC().Add(ttl)
}

func isIdempotencyConflict(err error) bool {
	var conflictErr *domain.ConflictError
	if ok := errors.As(err, &conflictErr); !ok {
		return false
	}
	return conflictErr.ResourceType == "idempotency_key"
}

// evaluateArbiterSafe wraps arbiter evaluation with panic recovery.
// On any panic, degrades to require-review for writer safety.
func (s *ProposalService) evaluateArbiterSafe(ctx context.Context, input collabSvc.ArbiterInput) (decision collabSvc.ArbiterDecision) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("arbiter panicked, degrading to require-review",
				"panic", fmt.Sprintf("%v", r),
				"document_id", input.DocumentID,
			)
			decision = collabSvc.ArbiterDecision{
				Verdict: collabSvc.ArbiterVerdictRequireReview,
				Reason:  "arbiter panic recovery",
			}
		}
	}()
	return s.arbiter.Evaluate(ctx, input)
}

func (s *ProposalService) resolveAutoAccept(agent *bool, inputs *collabSvc.AutoAcceptPolicyInputs) bool {
	if agent != nil {
		return *agent
	}
	if inputs != nil && inputs.Project != nil {
		return *inputs.Project
	}
	if inputs != nil && inputs.User != nil {
		return *inputs.User
	}
	return s.defaultAutoAcceptValue
}
