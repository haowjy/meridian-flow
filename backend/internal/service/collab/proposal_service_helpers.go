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
	collabSvc "meridian/internal/domain/services/collab"
)

// --- Idempotency replay helpers ---

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

// --- Idempotency validation helpers ---

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

// --- Auto-accept resolution ---

// resolveAutoAccept resolves the auto-accept decision from the tri-state cascade:
// agent override > project policy > user policy > service default.
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

// --- Arbiter evaluation ---

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
