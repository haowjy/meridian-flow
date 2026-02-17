package collab

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	"meridian/internal/domain/repositories"
	collabSvc "meridian/internal/domain/services/collab"
)

func TestProposalServiceAcceptProposal_IdempotencyReplayAndConflict(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	idempotency := newFakeIdempotencyStore()
	runtime := newFakeProposalRuntime(nil)
	autoAccept := &fakeAutoAcceptPolicyStore{}
	projector := &fakeAIContentProjector{}

	proposal := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      uuid.New(),
		Status:          collabModels.ProposalStatusProposed,
		YjsUpdate:       []byte("update-1"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       time.Now().UTC(),
	}
	stores.put(proposal)

	svc := NewProposalService(stores, idempotency, fakeTxManager{}, runtime, autoAccept, projector, false)
	userID := uuid.New()
	req := collabSvc.AcceptProposalRequest{
		ProposalID:     proposal.ID,
		UserID:         userID,
		IdempotencyKey: "accept-key",
		RequestHash:    "hash-a",
	}

	first, err := svc.AcceptProposal(ctx, req)
	if err != nil {
		t.Fatalf("accept proposal: %v", err)
	}
	if first.IsReplay {
		t.Fatalf("expected first accept call to not be replay")
	}
	if len(first.Mutations) != 1 {
		t.Fatalf("expected one mutation, got %d", len(first.Mutations))
	}
	if len(runtime.calls) != 1 {
		t.Fatalf("expected one runtime apply, got %d", len(runtime.calls))
	}
	if len(projector.documentIDs) != 1 {
		t.Fatalf("expected one ai_content recompute, got %d", len(projector.documentIDs))
	}

	second, err := svc.AcceptProposal(ctx, req)
	if err != nil {
		t.Fatalf("accept replay: %v", err)
	}
	if !second.IsReplay {
		t.Fatalf("expected replay call to be marked replay")
	}
	if len(runtime.calls) != 1 {
		t.Fatalf("expected replay to avoid extra applies, got %d applies", len(runtime.calls))
	}
	if len(projector.documentIDs) != 1 {
		t.Fatalf("expected replay to avoid extra recomputes, got %d", len(projector.documentIDs))
	}

	_, err = svc.AcceptProposal(ctx, collabSvc.AcceptProposalRequest{
		ProposalID:     proposal.ID,
		UserID:         userID,
		IdempotencyKey: req.IdempotencyKey,
		RequestHash:    "hash-b",
	})
	if err == nil {
		t.Fatal("expected idempotency conflict error")
	}
	var conflictErr *domain.ConflictError
	if !errors.As(err, &conflictErr) {
		t.Fatalf("expected conflict error, got %T", err)
	}
}

func TestProposalServiceRejectProposal_TerminalBehavior(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	idempotency := newFakeIdempotencyStore()
	runtime := newFakeProposalRuntime(nil)
	autoAccept := &fakeAutoAcceptPolicyStore{}
	projector := &fakeAIContentProjector{}

	proposed := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      uuid.New(),
		Status:          collabModels.ProposalStatusProposed,
		YjsUpdate:       []byte("u1"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       time.Now().UTC(),
	}
	accepted := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      uuid.New(),
		Status:          collabModels.ProposalStatusAccepted,
		YjsUpdate:       []byte("u2"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       time.Now().UTC(),
	}
	stores.put(proposed)
	stores.put(accepted)

	svc := NewProposalService(stores, idempotency, fakeTxManager{}, runtime, autoAccept, projector, false)
	userID := uuid.New()

	first, err := svc.RejectProposal(ctx, collabSvc.RejectProposalRequest{
		ProposalID: proposed.ID,
		UserID:     userID,
	})
	if err != nil {
		t.Fatalf("reject proposed: %v", err)
	}
	if first.Noop {
		t.Fatalf("expected first reject to mutate proposal")
	}
	if len(first.Mutations) != 1 {
		t.Fatalf("expected one mutation from first reject, got %d", len(first.Mutations))
	}
	if len(projector.documentIDs) != 1 {
		t.Fatalf("expected one recompute for first reject, got %d", len(projector.documentIDs))
	}

	second, err := svc.RejectProposal(ctx, collabSvc.RejectProposalRequest{
		ProposalID: proposed.ID,
		UserID:     userID,
	})
	if err != nil {
		t.Fatalf("reject already rejected: %v", err)
	}
	if !second.Noop {
		t.Fatalf("expected second reject to be noop")
	}
	if len(second.Mutations) != 0 {
		t.Fatalf("expected no mutation on noop reject, got %d", len(second.Mutations))
	}
	if len(projector.documentIDs) != 1 {
		t.Fatalf("expected noop reject to avoid recompute, got %d", len(projector.documentIDs))
	}

	_, err = svc.RejectProposal(ctx, collabSvc.RejectProposalRequest{
		ProposalID: accepted.ID,
		UserID:     userID,
	})
	if err == nil {
		t.Fatal("expected rejecting accepted proposal to fail")
	}
}

func TestProposalServiceGroupAccept_DeterministicOutcomesAndReplay(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	idempotency := newFakeIdempotencyStore()
	autoAccept := &fakeAutoAcceptPolicyStore{}
	projector := &fakeAIContentProjector{}

	groupID := uuid.New()
	docID := uuid.New()
	created := time.Now().UTC()
	p1 := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      docID,
		ProposalGroupID: &groupID,
		Status:          collabModels.ProposalStatusProposed,
		YjsUpdate:       []byte("u1"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       created.Add(1 * time.Minute),
	}
	p2 := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      docID,
		ProposalGroupID: &groupID,
		Status:          collabModels.ProposalStatusProposed,
		YjsUpdate:       []byte("u2"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       created.Add(2 * time.Minute),
	}
	p3 := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      docID,
		ProposalGroupID: &groupID,
		Status:          collabModels.ProposalStatusProposed,
		YjsUpdate:       []byte("u3"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       created.Add(3 * time.Minute),
	}
	// Insert out of order to verify ListByGroup deterministic sorting.
	stores.put(p3)
	stores.put(p1)
	stores.put(p2)

	runtime := newFakeProposalRuntime(map[string]error{
		string(p2.YjsUpdate): domain.NewValidationError("bad update"),
	})
	svc := NewProposalService(stores, idempotency, fakeTxManager{}, runtime, autoAccept, projector, false)

	userID := uuid.New()
	req := collabSvc.GroupAcceptRequest{
		DocumentID:      docID,
		ProposalGroupID: groupID,
		UserID:          userID,
		IdempotencyKey:  "group-key",
		RequestHash:     "group-hash",
	}

	first, err := svc.GroupAccept(ctx, req)
	if err != nil {
		t.Fatalf("group accept: %v", err)
	}
	if first.IsReplay {
		t.Fatalf("expected first group accept to not be replay")
	}

	if len(first.Payload.Outcomes) != 3 {
		t.Fatalf("expected 3 outcomes, got %d", len(first.Payload.Outcomes))
	}
	if first.Payload.Outcomes[0].ProposalID != p1.ID ||
		first.Payload.Outcomes[1].ProposalID != p2.ID ||
		first.Payload.Outcomes[2].ProposalID != p3.ID {
		t.Fatalf("outcomes not in deterministic order: %+v", first.Payload.Outcomes)
	}
	if first.Payload.Outcomes[0].Status != collabModels.GroupAcceptOutcomeStatusAccepted {
		t.Fatalf("expected p1 accepted, got %s", first.Payload.Outcomes[0].Status)
	}
	if first.Payload.Outcomes[1].Status != collabModels.GroupAcceptOutcomeStatusSkipped {
		t.Fatalf("expected p2 skipped, got %s", first.Payload.Outcomes[1].Status)
	}
	if first.Payload.Outcomes[2].Status != collabModels.GroupAcceptOutcomeStatusAccepted {
		t.Fatalf("expected p3 accepted, got %s", first.Payload.Outcomes[2].Status)
	}
	if len(first.Mutations) != 2 {
		t.Fatalf("expected only accepted proposals to emit mutations, got %d", len(first.Mutations))
	}
	if len(projector.documentIDs) != 1 {
		t.Fatalf("expected one recompute for group accept, got %d", len(projector.documentIDs))
	}

	second, err := svc.GroupAccept(ctx, req)
	if err != nil {
		t.Fatalf("group accept replay: %v", err)
	}
	if !second.IsReplay {
		t.Fatalf("expected second group accept to replay")
	}
	if len(runtime.calls) != 3 {
		t.Fatalf("expected replay to avoid extra applies, got %d calls", len(runtime.calls))
	}
	if len(projector.documentIDs) != 1 {
		t.Fatalf("expected replay to avoid extra recomputes, got %d", len(projector.documentIDs))
	}

	_, err = svc.GroupAccept(ctx, collabSvc.GroupAcceptRequest{
		DocumentID:      docID,
		ProposalGroupID: groupID,
		UserID:          userID,
		IdempotencyKey:  req.IdempotencyKey,
		RequestHash:     "group-hash-other",
	})
	if err == nil {
		t.Fatal("expected idempotency conflict on group accept hash mismatch")
	}
}

func TestProposalServiceGroupAccept_SkipsDifferentDocumentInGroup(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	idempotency := newFakeIdempotencyStore()
	runtime := newFakeProposalRuntime(nil)
	autoAccept := &fakeAutoAcceptPolicyStore{}
	projector := &fakeAIContentProjector{}

	groupID := uuid.New()
	targetDocID := uuid.New()
	otherDocID := uuid.New()
	created := time.Now().UTC()
	p1 := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      targetDocID,
		ProposalGroupID: &groupID,
		Status:          collabModels.ProposalStatusProposed,
		YjsUpdate:       []byte("u1"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       created.Add(1 * time.Minute),
	}
	p2 := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      otherDocID,
		ProposalGroupID: &groupID,
		Status:          collabModels.ProposalStatusProposed,
		YjsUpdate:       []byte("u2"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       created.Add(2 * time.Minute),
	}
	stores.put(p1)
	stores.put(p2)

	svc := NewProposalService(stores, idempotency, fakeTxManager{}, runtime, autoAccept, projector, false)
	req := collabSvc.GroupAcceptRequest{
		DocumentID:      targetDocID,
		ProposalGroupID: groupID,
		UserID:          uuid.New(),
		IdempotencyKey:  "group-doc-scope-key",
		RequestHash:     "group-doc-scope-hash",
	}

	result, err := svc.GroupAccept(ctx, req)
	if err != nil {
		t.Fatalf("group accept: %v", err)
	}
	if len(result.Payload.Outcomes) != 2 {
		t.Fatalf("expected 2 outcomes, got %d", len(result.Payload.Outcomes))
	}
	if result.Payload.Outcomes[0].Status != collabModels.GroupAcceptOutcomeStatusAccepted {
		t.Fatalf("expected first proposal accepted, got %s", result.Payload.Outcomes[0].Status)
	}
	if result.Payload.Outcomes[1].Status != collabModels.GroupAcceptOutcomeStatusSkipped {
		t.Fatalf("expected second proposal skipped, got %s", result.Payload.Outcomes[1].Status)
	}
	if result.Payload.Outcomes[1].Error == nil {
		t.Fatal("expected mismatch error for skipped proposal")
	}
	if !strings.Contains(*result.Payload.Outcomes[1].Error, "document mismatch") {
		t.Fatalf("expected document mismatch error, got %q", *result.Payload.Outcomes[1].Error)
	}
	if len(result.Mutations) != 1 {
		t.Fatalf("expected one mutation, got %d", len(result.Mutations))
	}
	if len(runtime.calls) != 1 {
		t.Fatalf("expected one runtime apply, got %d", len(runtime.calls))
	}
	if len(projector.documentIDs) != 1 {
		t.Fatalf("expected one recompute for one accepted proposal, got %d", len(projector.documentIDs))
	}
}

func TestProposalServiceGroupAccept_TransientMarkAcceptedErrorAborts(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	idempotency := newFakeIdempotencyStore()
	runtime := newFakeProposalRuntime(nil)
	autoAccept := &fakeAutoAcceptPolicyStore{}
	projector := &fakeAIContentProjector{}

	groupID := uuid.New()
	docID := uuid.New()
	proposal := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      docID,
		ProposalGroupID: &groupID,
		Status:          collabModels.ProposalStatusProposed,
		YjsUpdate:       []byte("u1"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       time.Now().UTC(),
	}
	stores.put(proposal)

	expectedErr := errors.New("db connection dropped")
	stores.markAcceptedErrs[proposal.ID] = expectedErr
	svc := NewProposalService(stores, idempotency, fakeTxManager{}, runtime, autoAccept, projector, false)

	_, err := svc.GroupAccept(ctx, collabSvc.GroupAcceptRequest{
		DocumentID:      docID,
		ProposalGroupID: groupID,
		UserID:          uuid.New(),
		IdempotencyKey:  "group-transient-key",
		RequestHash:     "group-transient-hash",
	})
	if err == nil {
		t.Fatal("expected transient mark accepted error")
	}
	if !errors.Is(err, expectedErr) {
		t.Fatalf("expected wrapped transient error, got %v", err)
	}
	if len(projector.documentIDs) != 0 {
		t.Fatalf("expected transient error to avoid recompute, got %d", len(projector.documentIDs))
	}
}

func TestProposalServiceCreateProposal_AutoAcceptCascade(t *testing.T) {
	ctx := context.Background()
	docID := uuid.New()
	userID := uuid.New()

	testCases := []struct {
		name                string
		agentOverride       *bool
		projectValue        *bool
		userValue           *bool
		systemDefault       bool
		expectAccepted      bool
		expectPolicyLookups int
	}{
		{
			name:                "agent override true wins",
			agentOverride:       boolPtr(true),
			projectValue:        boolPtr(false),
			userValue:           boolPtr(false),
			systemDefault:       false,
			expectAccepted:      true,
			expectPolicyLookups: 0,
		},
		{
			name:                "agent override false wins",
			agentOverride:       boolPtr(false),
			projectValue:        boolPtr(true),
			userValue:           boolPtr(true),
			systemDefault:       true,
			expectAccepted:      false,
			expectPolicyLookups: 0,
		},
		{
			name:                "project wins over user",
			agentOverride:       nil,
			projectValue:        boolPtr(false),
			userValue:           boolPtr(true),
			systemDefault:       true,
			expectAccepted:      false,
			expectPolicyLookups: 1,
		},
		{
			name:                "user wins over system",
			agentOverride:       nil,
			projectValue:        nil,
			userValue:           boolPtr(true),
			systemDefault:       false,
			expectAccepted:      true,
			expectPolicyLookups: 1,
		},
		{
			name:                "system default fallback",
			agentOverride:       nil,
			projectValue:        nil,
			userValue:           nil,
			systemDefault:       false,
			expectAccepted:      false,
			expectPolicyLookups: 1,
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			stores := newFakeProposalStore()
			idempotency := newFakeIdempotencyStore()
			runtime := newFakeProposalRuntime(nil)
			projector := &fakeAIContentProjector{}
			autoAccept := &fakeAutoAcceptPolicyStore{
				inputs: &collabSvc.AutoAcceptPolicyInputs{
					Project: tc.projectValue,
					User:    tc.userValue,
				},
			}

			svc := NewProposalService(stores, idempotency, fakeTxManager{}, runtime, autoAccept, projector, tc.systemDefault)
			created, err := svc.CreateProposal(ctx, collabSvc.CreateProposalRequest{
				DocumentID:        docID,
				Source:            collabModels.ProposalSourceAI,
				ProducerAgentType: "writer",
				ThreadID:          uuid.New(),
				AgentRunID:        uuid.New(),
				YjsUpdate:         []byte("new-update"),
				CreatedByUserID:   userID,
				AgentAutoAccept:   tc.agentOverride,
			})
			if err != nil {
				t.Fatalf("create proposal: %v", err)
			}

			if autoAccept.lookupCount != tc.expectPolicyLookups {
				t.Fatalf("expected %d policy lookups, got %d", tc.expectPolicyLookups, autoAccept.lookupCount)
			}

			stored, err := stores.GetByID(ctx, created.ID)
			if err != nil {
				t.Fatalf("load stored proposal: %v", err)
			}

			if tc.expectAccepted {
				if stored.Status != collabModels.ProposalStatusAccepted {
					t.Fatalf("expected accepted proposal, got %s", stored.Status)
				}
				if len(runtime.calls) != 1 {
					t.Fatalf("expected one runtime apply for auto-accept, got %d", len(runtime.calls))
				}
				if len(projector.documentIDs) != 2 {
					t.Fatalf("expected two recomputes for auto-accept, got %d", len(projector.documentIDs))
				}
			} else {
				if stored.Status != collabModels.ProposalStatusProposed {
					t.Fatalf("expected proposed status, got %s", stored.Status)
				}
				if len(runtime.calls) != 0 {
					t.Fatalf("expected no runtime apply, got %d", len(runtime.calls))
				}
				if len(projector.documentIDs) != 1 {
					t.Fatalf("expected one recompute for non-auto-accept create, got %d", len(projector.documentIDs))
				}
			}
		})
	}
}

type fakeTxManager struct{}

func (fakeTxManager) ExecTx(ctx context.Context, fn repositories.TxFn) error {
	return fn(ctx)
}

type fakeProposalStore struct {
	proposals        map[uuid.UUID]collabModels.Proposal
	markAcceptedErrs map[uuid.UUID]error
}

func newFakeProposalStore() *fakeProposalStore {
	return &fakeProposalStore{
		proposals:        map[uuid.UUID]collabModels.Proposal{},
		markAcceptedErrs: map[uuid.UUID]error{},
	}
}

func (s *fakeProposalStore) put(p collabModels.Proposal) {
	s.proposals[p.ID] = p
}

func (s *fakeProposalStore) Create(_ context.Context, proposal *collabModels.Proposal) error {
	if proposal.ID == uuid.Nil {
		proposal.ID = uuid.New()
	}
	if proposal.CreatedAt.IsZero() {
		proposal.CreatedAt = time.Now().UTC()
	}
	if proposal.Status == "" {
		proposal.Status = collabModels.ProposalStatusProposed
	}
	s.proposals[proposal.ID] = *proposal
	return nil
}

func (s *fakeProposalStore) GetByID(_ context.Context, proposalID uuid.UUID) (*collabModels.Proposal, error) {
	proposal, ok := s.proposals[proposalID]
	if !ok {
		return nil, domain.NewNotFoundError("proposal", "proposal not found")
	}
	copy := proposal
	return &copy, nil
}

func (s *fakeProposalStore) ListByDocument(
	_ context.Context,
	documentID uuid.UUID,
	status *collabModels.ProposalStatus,
	_ int,
	_ int,
) ([]collabModels.Proposal, error) {
	out := make([]collabModels.Proposal, 0)
	for _, proposal := range s.proposals {
		if proposal.DocumentID != documentID {
			continue
		}
		if status != nil && proposal.Status != *status {
			continue
		}
		out = append(out, proposal)
	}
	return out, nil
}

func (s *fakeProposalStore) ListByGroup(
	_ context.Context,
	proposalGroupID uuid.UUID,
	status *collabModels.ProposalStatus,
) ([]collabModels.Proposal, error) {
	out := make([]collabModels.Proposal, 0)
	for _, proposal := range s.proposals {
		if proposal.ProposalGroupID == nil || *proposal.ProposalGroupID != proposalGroupID {
			continue
		}
		if status != nil && proposal.Status != *status {
			continue
		}
		out = append(out, proposal)
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].ID.String() < out[j].ID.String()
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})

	return out, nil
}

func (s *fakeProposalStore) MarkAccepted(_ context.Context, decision collabModels.ProposalDecision) error {
	if err, ok := s.markAcceptedErrs[decision.ProposalID]; ok {
		return err
	}
	proposal, ok := s.proposals[decision.ProposalID]
	if !ok {
		return domain.NewNotFoundError("proposal", "proposal not found")
	}
	if proposal.Status != collabModels.ProposalStatusProposed {
		return domain.NewValidationError("proposal is not proposed")
	}
	proposal.Status = collabModels.ProposalStatusAccepted
	proposal.DecidedByUserID = &decision.DecidedByUserID
	proposal.DecidedAt = &decision.DecidedAt
	s.proposals[proposal.ID] = proposal
	return nil
}

func (s *fakeProposalStore) MarkRejected(_ context.Context, decision collabModels.ProposalDecision) error {
	proposal, ok := s.proposals[decision.ProposalID]
	if !ok {
		return domain.NewNotFoundError("proposal", "proposal not found")
	}
	if proposal.Status != collabModels.ProposalStatusProposed {
		return domain.NewValidationError("proposal is not proposed")
	}
	proposal.Status = collabModels.ProposalStatusRejected
	proposal.DecidedByUserID = &decision.DecidedByUserID
	proposal.DecidedAt = &decision.DecidedAt
	s.proposals[proposal.ID] = proposal
	return nil
}

type fakeIdempotencyStore struct {
	records map[string]collabModels.IdempotencyRecord
}

func newFakeIdempotencyStore() *fakeIdempotencyStore {
	return &fakeIdempotencyStore{
		records: map[string]collabModels.IdempotencyRecord{},
	}
}

func (s *fakeIdempotencyStore) GetByUserAndKey(
	_ context.Context,
	userID uuid.UUID,
	idempotencyKey string,
) (*collabModels.IdempotencyRecord, error) {
	record, ok := s.records[s.key(userID, idempotencyKey)]
	if !ok {
		return nil, nil
	}
	copy := record
	return &copy, nil
}

func (s *fakeIdempotencyStore) Create(_ context.Context, record *collabModels.IdempotencyRecord) error {
	key := s.key(record.UserID, record.IdempotencyKey)
	if _, exists := s.records[key]; exists {
		return domain.NewConflictError("idempotency_key", record.IdempotencyKey, "idempotency key already exists")
	}
	if record.ID == uuid.Nil {
		record.ID = uuid.New()
	}
	if record.CreatedAt.IsZero() {
		record.CreatedAt = time.Now().UTC()
	}
	copy := *record
	if record.ResponsePayload != nil {
		copy.ResponsePayload = append([]byte{}, record.ResponsePayload...)
	}
	s.records[key] = copy
	return nil
}

func (s *fakeIdempotencyStore) DeleteExpired(_ context.Context, now time.Time) (int64, error) {
	var deleted int64
	for key, record := range s.records {
		if record.ExpiresAt.Before(now) {
			delete(s.records, key)
			deleted++
		}
	}
	return deleted, nil
}

func (s *fakeIdempotencyStore) key(userID uuid.UUID, idempotencyKey string) string {
	return userID.String() + "|" + idempotencyKey
}

type fakeProposalRuntime struct {
	failures map[string]error
	calls    []string
}

func newFakeProposalRuntime(failures map[string]error) *fakeProposalRuntime {
	if failures == nil {
		failures = map[string]error{}
	}
	return &fakeProposalRuntime{
		failures: failures,
		calls:    []string{},
	}
}

func (r *fakeProposalRuntime) ApplyUpdate(_ context.Context, _ uuid.UUID, update []byte, _ string) error {
	key := string(update)
	r.calls = append(r.calls, key)
	if err, ok := r.failures[key]; ok {
		return err
	}
	return nil
}

func (r *fakeProposalRuntime) GetStateSnapshot(_ context.Context, _ uuid.UUID) ([]byte, bool, error) {
	return nil, false, nil
}

type fakeAutoAcceptPolicyStore struct {
	inputs      *collabSvc.AutoAcceptPolicyInputs
	lookupCount int
}

func (s *fakeAutoAcceptPolicyStore) GetPolicyInputs(
	_ context.Context,
	_ uuid.UUID,
	_ uuid.UUID,
) (*collabSvc.AutoAcceptPolicyInputs, error) {
	s.lookupCount++
	if s.inputs == nil {
		return &collabSvc.AutoAcceptPolicyInputs{}, nil
	}
	return s.inputs, nil
}

type fakeAIContentProjector struct {
	documentIDs []uuid.UUID
}

func (p *fakeAIContentProjector) Recompute(_ context.Context, documentID uuid.UUID) error {
	p.documentIDs = append(p.documentIDs, documentID)
	return nil
}

func boolPtr(v bool) *bool {
	return &v
}

func TestFakeIdempotencyStorePayloadRoundTrip(t *testing.T) {
	store := newFakeIdempotencyStore()
	userID := uuid.New()

	payload, err := json.Marshal(collabModels.ProposalAcceptResponsePayload{ProposalID: uuid.New()})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	record := &collabModels.IdempotencyRecord{
		UserID:          userID,
		IdempotencyKey:  "k",
		RequestScope:    collabModels.IdempotencyScopeProposalAccept,
		ScopeID:         uuid.New(),
		RequestHash:     "h",
		DocumentID:      uuid.New(),
		ResponsePayload: payload,
		ExpiresAt:       time.Now().Add(time.Hour),
	}
	if err := store.Create(context.Background(), record); err != nil {
		t.Fatalf("create record: %v", err)
	}

	got, err := store.GetByUserAndKey(context.Background(), userID, "k")
	if err != nil {
		t.Fatalf("get record: %v", err)
	}
	if got == nil {
		t.Fatal("expected idempotency record")
	}
}
