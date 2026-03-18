package collab

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	"meridian/internal/domain/repositories"
	collabSvc "meridian/internal/domain/services/collab"
)

func TestProposalServiceAcceptProposal_SecondAcceptFailsWhenAlreadyAccepted(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	runtime := newFakeProposalRuntime(nil)
	autoAccept := &fakeAutoAcceptPolicyStore{}

	proposal := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      uuid.New(),
		Status:          collabModels.ProposalStatusPending,
		YjsUpdate:       []byte("update-1"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       time.Now().UTC(),
	}
	stores.put(proposal)

	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, NoOpArbiter, false)
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
	if runtime.callCount() != 1 {
		t.Fatalf("expected one runtime apply, got %d", runtime.callCount())
	}

	_, err = svc.AcceptProposal(ctx, req)
	if err == nil {
		t.Fatal("expected second accept to fail")
	}
	var validationErr *domain.ValidationError
	if !errors.As(err, &validationErr) {
		t.Fatalf("expected validation error, got %T", err)
	}
	if runtime.callCount() != 1 {
		t.Fatalf("expected second accept to avoid extra runtime apply, got %d", runtime.callCount())
	}
}

func TestProposalServiceAcceptProposal_SerializesSameDocument(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	autoAccept := &fakeAutoAcceptPolicyStore{}
	runtime := newFakeProposalRuntime(nil)

	documentID := uuid.New()
	firstProposal := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      documentID,
		Status:          collabModels.ProposalStatusPending,
		YjsUpdate:       []byte("u1"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       time.Now().UTC(),
	}
	secondProposal := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      documentID,
		Status:          collabModels.ProposalStatusPending,
		YjsUpdate:       []byte("u2"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       time.Now().UTC().Add(time.Second),
	}
	stores.put(firstProposal)
	stores.put(secondProposal)

	firstStarted := make(chan struct{})
	secondStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	runtime.applyHook = func(_ uuid.UUID, update []byte) {
		switch string(update) {
		case "u1":
			close(firstStarted)
			<-releaseFirst
		case "u2":
			close(secondStarted)
		}
	}

	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, NoOpArbiter, false)
	errCh := make(chan error, 2)

	go func() {
		_, err := svc.AcceptProposal(ctx, collabSvc.AcceptProposalRequest{
			ProposalID:     firstProposal.ID,
			UserID:         uuid.New(),
			IdempotencyKey: "same-doc-key-1",
			RequestHash:    "same-doc-hash-1",
		})
		errCh <- err
	}()

	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first accept to reach runtime apply")
	}

	go func() {
		_, err := svc.AcceptProposal(ctx, collabSvc.AcceptProposalRequest{
			ProposalID:     secondProposal.ID,
			UserID:         uuid.New(),
			IdempotencyKey: "same-doc-key-2",
			RequestHash:    "same-doc-hash-2",
		})
		errCh <- err
	}()

	select {
	case <-secondStarted:
		t.Fatal("second same-document accept entered runtime apply before first completed")
	case <-time.After(100 * time.Millisecond):
	}

	close(releaseFirst)

	for i := 0; i < 2; i++ {
		select {
		case err := <-errCh:
			if err != nil {
				t.Fatalf("accept failed: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for accept result")
		}
	}

	if runtime.maxInFlight() != 1 {
		t.Fatalf("expected max in-flight runtime apply to be 1 for same document, got %d", runtime.maxInFlight())
	}
}

func TestProposalServiceAcceptProposal_DifferentDocumentsProceedIndependently(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	autoAccept := &fakeAutoAcceptPolicyStore{}
	runtime := newFakeProposalRuntime(nil)

	firstProposal := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      uuid.New(),
		Status:          collabModels.ProposalStatusPending,
		YjsUpdate:       []byte("u1"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       time.Now().UTC(),
	}
	secondProposal := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      uuid.New(),
		Status:          collabModels.ProposalStatusPending,
		YjsUpdate:       []byte("u2"),
		CreatedByUserID: uuid.New(),
		CreatedAt:       time.Now().UTC().Add(time.Second),
	}
	stores.put(firstProposal)
	stores.put(secondProposal)

	firstStarted := make(chan struct{})
	secondStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	runtime.applyHook = func(_ uuid.UUID, update []byte) {
		switch string(update) {
		case "u1":
			close(firstStarted)
			<-releaseFirst
		case "u2":
			close(secondStarted)
		}
	}

	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, NoOpArbiter, false)
	errCh := make(chan error, 2)

	go func() {
		_, err := svc.AcceptProposal(ctx, collabSvc.AcceptProposalRequest{
			ProposalID:     firstProposal.ID,
			UserID:         uuid.New(),
			IdempotencyKey: "diff-doc-key-1",
			RequestHash:    "diff-doc-hash-1",
		})
		errCh <- err
	}()

	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first accept to reach runtime apply")
	}

	go func() {
		_, err := svc.AcceptProposal(ctx, collabSvc.AcceptProposalRequest{
			ProposalID:     secondProposal.ID,
			UserID:         uuid.New(),
			IdempotencyKey: "diff-doc-key-2",
			RequestHash:    "diff-doc-hash-2",
		})
		errCh <- err
	}()

	select {
	case <-secondStarted:
	case <-time.After(time.Second):
		t.Fatal("second different-document accept did not proceed while first was blocked")
	}

	close(releaseFirst)

	for i := 0; i < 2; i++ {
		select {
		case err := <-errCh:
			if err != nil {
				t.Fatalf("accept failed: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for accept result")
		}
	}

	if runtime.maxInFlight() < 2 {
		t.Fatalf("expected concurrent runtime applies across different documents, got max in-flight %d", runtime.maxInFlight())
	}
}

func TestProposalServiceRejectProposal_TerminalBehavior(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	runtime := newFakeProposalRuntime(nil)
	autoAccept := &fakeAutoAcceptPolicyStore{}

	pending := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      uuid.New(),
		Status:          collabModels.ProposalStatusPending,
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
	stores.put(pending)
	stores.put(accepted)

	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, NoOpArbiter, false)
	userID := uuid.New()

	first, err := svc.RejectProposal(ctx, collabSvc.RejectProposalRequest{
		ProposalID: pending.ID,
		UserID:     userID,
	})
	if err != nil {
		t.Fatalf("reject pending: %v", err)
	}
	if first.Noop {
		t.Fatalf("expected first reject to mutate proposal")
	}
	if len(first.Mutations) != 1 {
		t.Fatalf("expected one mutation from first reject, got %d", len(first.Mutations))
	}

	second, err := svc.RejectProposal(ctx, collabSvc.RejectProposalRequest{
		ProposalID: pending.ID,
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

	_, err = svc.RejectProposal(ctx, collabSvc.RejectProposalRequest{
		ProposalID: accepted.ID,
		UserID:     userID,
	})
	if err == nil {
		t.Fatal("expected rejecting accepted proposal to fail")
	}
}

func TestProposalServiceGroupAccept_DeterministicOutcomesAndSecondCallSkips(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	autoAccept := &fakeAutoAcceptPolicyStore{}

	groupID := uuid.New()
	docID := uuid.New()
	created := time.Now().UTC()

	// Build real Yjs updates so composition works in the temp doc.
	baseState := buildDocState(t, "Line 1\nLine 2\nLine 3")
	update1, err := TextToUpdate(baseState, "Modified Line 1\nLine 2\nLine 3", &TextEdit{
		OldText: "Line 1", NewText: "Modified Line 1", Position: 0,
	})
	if err != nil {
		t.Fatalf("build update1: %v", err)
	}
	projState1 := applyUpdateToState(t, baseState, update1)
	update2, err := TextToUpdate(projState1, "Modified Line 1\nChanged Line 2\nLine 3", &TextEdit{
		OldText: "Line 2", NewText: "Changed Line 2",
		Position: len("Modified Line 1\n"),
	})
	if err != nil {
		t.Fatalf("build update2: %v", err)
	}
	projState2 := applyUpdateToState(t, projState1, update2)
	update3, err := TextToUpdate(projState2, "Modified Line 1\nChanged Line 2\nModified Line 3", &TextEdit{
		OldText: "Line 3", NewText: "Modified Line 3",
		Position: len("Modified Line 1\nChanged Line 2\n"),
	})
	if err != nil {
		t.Fatalf("build update3: %v", err)
	}

	p1 := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      docID,
		ProposalGroupID: &groupID,
		Status:          collabModels.ProposalStatusPending,
		YjsUpdate:       update1,
		CreatedByUserID: uuid.New(),
		CreatedAt:       created.Add(1 * time.Minute),
	}
	p2 := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      docID,
		ProposalGroupID: &groupID,
		Status:          collabModels.ProposalStatusPending,
		YjsUpdate:       update2,
		CreatedByUserID: uuid.New(),
		CreatedAt:       created.Add(2 * time.Minute),
	}
	p3 := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      docID,
		ProposalGroupID: &groupID,
		Status:          collabModels.ProposalStatusPending,
		YjsUpdate:       update3,
		CreatedByUserID: uuid.New(),
		CreatedAt:       created.Add(3 * time.Minute),
	}
	// Insert out of order to verify ListByGroup deterministic sorting.
	stores.put(p3)
	stores.put(p1)
	stores.put(p2)

	// Inject a ValidationError on MarkAccepted for p2 to test skip path.
	stores.markAcceptedErrs[p2.ID] = domain.NewValidationError("already decided")

	runtime := newFakeProposalRuntime(nil)
	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, NoOpArbiter, false)

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

	second, err := svc.GroupAccept(ctx, req)
	if err != nil {
		t.Fatalf("second group accept: %v", err)
	}
	if second.IsReplay {
		t.Fatalf("expected second group accept to execute, not replay")
	}
	if len(second.Mutations) != 0 {
		t.Fatalf("expected no mutations on second group accept, got %d", len(second.Mutations))
	}
	// Without idempotency replay, the second call executes again for still-pending rows.
	if runtime.callCount() != 2 {
		t.Fatalf("expected two runtime applies across two calls, got %d", runtime.callCount())
	}
}

func TestProposalServiceGroupAccept_SkipsDifferentDocumentInGroup(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	runtime := newFakeProposalRuntime(nil)
	autoAccept := &fakeAutoAcceptPolicyStore{}

	groupID := uuid.New()
	targetDocID := uuid.New()
	otherDocID := uuid.New()
	created := time.Now().UTC()

	// Build real Yjs update for the matching proposal.
	baseState := buildDocState(t, "hello world")
	update1, err := TextToUpdate(baseState, "hello Go", nil)
	if err != nil {
		t.Fatalf("build update1: %v", err)
	}

	p1 := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      targetDocID,
		ProposalGroupID: &groupID,
		Status:          collabModels.ProposalStatusPending,
		YjsUpdate:       update1,
		CreatedByUserID: uuid.New(),
		CreatedAt:       created.Add(1 * time.Minute),
	}
	p2 := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      otherDocID,
		ProposalGroupID: &groupID,
		Status:          collabModels.ProposalStatusPending,
		YjsUpdate:       []byte("u2"), // never composed (doc mismatch skip)
		CreatedByUserID: uuid.New(),
		CreatedAt:       created.Add(2 * time.Minute),
	}
	stores.put(p1)
	stores.put(p2)

	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, NoOpArbiter, false)
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
	if runtime.callCount() != 1 {
		t.Fatalf("expected one runtime apply, got %d", runtime.callCount())
	}
}

func TestProposalServiceGroupAccept_TransientMarkAcceptedErrorAborts(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	runtime := newFakeProposalRuntime(nil)
	autoAccept := &fakeAutoAcceptPolicyStore{}

	groupID := uuid.New()
	docID := uuid.New()

	// Build real Yjs update so composition succeeds.
	baseState := buildDocState(t, "some content")
	realUpdate, updateErr := TextToUpdate(baseState, "modified content", nil)
	if updateErr != nil {
		t.Fatalf("build real update: %v", updateErr)
	}

	proposal := collabModels.Proposal{
		ID:              uuid.New(),
		DocumentID:      docID,
		ProposalGroupID: &groupID,
		Status:          collabModels.ProposalStatusPending,
		YjsUpdate:       realUpdate,
		CreatedByUserID: uuid.New(),
		CreatedAt:       time.Now().UTC(),
	}
	stores.put(proposal)

	expectedErr := errors.New("db connection dropped")
	stores.markAcceptedErrs[proposal.ID] = expectedErr
	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, NoOpArbiter, false)

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
			runtime := newFakeProposalRuntime(nil)
			autoAccept := &fakeAutoAcceptPolicyStore{
				inputs: &collabSvc.AutoAcceptPolicyInputs{
					Project: tc.projectValue,
					User:    tc.userValue,
				},
			}

			svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, NoOpArbiter, tc.systemDefault)
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
				if runtime.callCount() != 1 {
					t.Fatalf("expected one runtime apply for auto-accept, got %d", runtime.callCount())
				}
			} else {
				if stored.Status != collabModels.ProposalStatusPending {
					t.Fatalf("expected pending status, got %s", stored.Status)
				}
				if runtime.callCount() != 0 {
					t.Fatalf("expected no runtime apply, got %d", runtime.callCount())
				}
			}
		})
	}
}

func TestProposalServiceCreateProposal_QueuedAIProposalCap(t *testing.T) {
	ctx := context.Background()
	docID := uuid.New()
	userID := uuid.New()

	stores := newFakeProposalStore()
	runtime := newFakeProposalRuntime(nil)
	autoAccept := &fakeAutoAcceptPolicyStore{}

	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, NoOpArbiter, false)
	createReq := collabSvc.CreateProposalRequest{
		DocumentID:        docID,
		Source:            collabModels.ProposalSourceAI,
		ProducerAgentType: "writer",
		ThreadID:          uuid.New(),
		AgentRunID:        uuid.New(),
		YjsUpdate:         []byte("queued-update"),
		CreatedByUserID:   userID,
		AgentAutoAccept:   boolPtr(false),
	}

	for i := 0; i < maxQueuedAIProposalsPerDocument; i++ {
		if _, err := svc.CreateProposal(ctx, createReq); err != nil {
			t.Fatalf("create queued proposal %d: %v", i+1, err)
		}
	}

	_, err := svc.CreateProposal(ctx, createReq)
	if err == nil {
		t.Fatal("expected queued AI proposal cap error")
	}

	var rateLimitErr *domain.RateLimitError
	if !errors.As(err, &rateLimitErr) {
		t.Fatalf("expected rate limit error, got %T", err)
	}

	count, err := stores.CountByDocumentAndStatusAndSource(
		ctx,
		docID,
		collabModels.ProposalStatusPending,
		collabModels.ProposalSourceAI,
	)
	if err != nil {
		t.Fatalf("count queued proposals: %v", err)
	}
	if count != maxQueuedAIProposalsPerDocument {
		t.Fatalf("expected %d queued AI proposals, got %d", maxQueuedAIProposalsPerDocument, count)
	}
}

func TestProposalServiceAcceptProposal_PendingCapAndRecovery(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	autoAccept := &fakeAutoAcceptPolicyStore{}
	runtime := newFakeProposalRuntime(nil)

	docID := uuid.New()
	userID := uuid.New()
	proposals := make([]collabModels.Proposal, 0, maxPendingAcceptOperationsPerDocument+1)
	for i := 0; i < maxPendingAcceptOperationsPerDocument+1; i++ {
		proposal := collabModels.Proposal{
			ID:              uuid.New(),
			DocumentID:      docID,
			Source:          collabModels.ProposalSourceAI,
			Status:          collabModels.ProposalStatusPending,
			YjsUpdate:       []byte(fmt.Sprintf("u-%d", i)),
			CreatedByUserID: userID,
			CreatedAt:       time.Now().UTC().Add(time.Duration(i) * time.Millisecond),
		}
		stores.put(proposal)
		proposals = append(proposals, proposal)
	}

	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	var hookOnce sync.Once
	runtime.applyHook = func(_ uuid.UUID, update []byte) {
		hookOnce.Do(func() {
			close(firstStarted)
			<-releaseFirst
		})
	}

	svcIface := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, NoOpArbiter, false)
	svc := svcIface.(*ProposalService)

	errCh := make(chan error, maxPendingAcceptOperationsPerDocument)
	for i := 0; i < maxPendingAcceptOperationsPerDocument; i++ {
		proposal := proposals[i]
		go func(idx int, p collabModels.Proposal) {
			_, err := svc.AcceptProposal(ctx, collabSvc.AcceptProposalRequest{
				ProposalID:     p.ID,
				UserID:         userID,
				IdempotencyKey: fmt.Sprintf("pending-cap-key-%d", idx),
				RequestHash:    fmt.Sprintf("pending-cap-hash-%d", idx),
			})
			errCh <- err
		}(i, proposal)
	}

	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for first accept to reach runtime apply")
	}

	deadline := time.Now().Add(2 * time.Second)
	for svc.acceptGate.pendingCount(docID) != maxPendingAcceptOperationsPerDocument {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for pending accepts to reach %d", maxPendingAcceptOperationsPerDocument)
		}
		time.Sleep(10 * time.Millisecond)
	}

	overflowProposal := proposals[maxPendingAcceptOperationsPerDocument]
	_, err := svc.AcceptProposal(ctx, collabSvc.AcceptProposalRequest{
		ProposalID:     overflowProposal.ID,
		UserID:         userID,
		IdempotencyKey: "pending-cap-overflow",
		RequestHash:    "pending-cap-overflow-hash",
	})
	if err == nil {
		t.Fatal("expected pending accept cap error")
	}

	var rateLimitErr *domain.RateLimitError
	if !errors.As(err, &rateLimitErr) {
		t.Fatalf("expected rate limit error, got %T", err)
	}

	close(releaseFirst)

	for i := 0; i < maxPendingAcceptOperationsPerDocument; i++ {
		select {
		case err := <-errCh:
			if err != nil {
				t.Fatalf("expected queued accept to succeed, got %v", err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for queued accepts")
		}
	}

	retry, err := svc.AcceptProposal(ctx, collabSvc.AcceptProposalRequest{
		ProposalID:     overflowProposal.ID,
		UserID:         userID,
		IdempotencyKey: "pending-cap-retry",
		RequestHash:    "pending-cap-retry-hash",
	})
	if err != nil {
		t.Fatalf("expected accept after drain to succeed, got %v", err)
	}
	if retry.IsReplay {
		t.Fatal("expected accept after drain to be non-replay")
	}
}

func TestProposalServiceCreateProposal_RejectsOversizedYjsUpdate(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	runtime := newFakeProposalRuntime(nil)
	autoAccept := &fakeAutoAcceptPolicyStore{}

	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, NoOpArbiter, false)
	_, err := svc.CreateProposal(ctx, collabSvc.CreateProposalRequest{
		DocumentID:        uuid.New(),
		Source:            collabModels.ProposalSourceAI,
		ProducerAgentType: "writer",
		ThreadID:          uuid.New(),
		AgentRunID:        uuid.New(),
		YjsUpdate:         make([]byte, maxProposalYjsUpdateBytes+1),
		CreatedByUserID:   uuid.New(),
	})
	if err == nil {
		t.Fatal("expected oversized yjs_update validation error")
	}

	var validationErr *domain.ValidationError
	if !errors.As(err, &validationErr) {
		t.Fatalf("expected validation error, got %T", err)
	}
	if validationErr.Field != "yjs_update" {
		t.Fatalf("expected field yjs_update, got %q", validationErr.Field)
	}
}

type fakeTxManager struct{}

func (fakeTxManager) ExecTx(ctx context.Context, fn repositories.TxFn) error {
	return fn(ctx)
}

type fakeProposalStore struct {
	mu               sync.Mutex
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
	s.mu.Lock()
	defer s.mu.Unlock()
	s.proposals[p.ID] = p
}

func (s *fakeProposalStore) Create(_ context.Context, proposal *collabModels.Proposal) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if proposal.ID == uuid.Nil {
		proposal.ID = uuid.New()
	}
	if proposal.CreatedAt.IsZero() {
		proposal.CreatedAt = time.Now().UTC()
	}
	if proposal.Status == "" {
		proposal.Status = collabModels.ProposalStatusPending
	}
	s.proposals[proposal.ID] = *proposal
	return nil
}

func (s *fakeProposalStore) GetByID(_ context.Context, proposalID uuid.UUID) (*collabModels.Proposal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
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
	s.mu.Lock()
	defer s.mu.Unlock()
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

func (s *fakeProposalStore) CountByDocumentAndStatusAndSource(
	_ context.Context,
	documentID uuid.UUID,
	status collabModels.ProposalStatus,
	source collabModels.ProposalSource,
) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	count := 0
	for _, proposal := range s.proposals {
		if proposal.DocumentID != documentID {
			continue
		}
		if proposal.Status != status {
			continue
		}
		if proposal.Source != source {
			continue
		}
		count++
	}
	return count, nil
}

func (s *fakeProposalStore) ListByGroup(
	_ context.Context,
	proposalGroupID uuid.UUID,
	status *collabModels.ProposalStatus,
) ([]collabModels.Proposal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
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
	s.mu.Lock()
	defer s.mu.Unlock()
	if err, ok := s.markAcceptedErrs[decision.ProposalID]; ok {
		return err
	}
	proposal, ok := s.proposals[decision.ProposalID]
	if !ok {
		return domain.NewNotFoundError("proposal", "proposal not found")
	}
	if proposal.Status != collabModels.ProposalStatusPending {
		return domain.NewValidationError("proposal is not pending")
	}
	proposal.Status = collabModels.ProposalStatusAccepted
	proposal.DecidedByUserID = &decision.DecidedByUserID
	proposal.DecidedAt = &decision.DecidedAt
	s.proposals[proposal.ID] = proposal
	return nil
}

func (s *fakeProposalStore) MarkRejected(_ context.Context, decision collabModels.ProposalDecision) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	proposal, ok := s.proposals[decision.ProposalID]
	if !ok {
		return domain.NewNotFoundError("proposal", "proposal not found")
	}
	if proposal.Status != collabModels.ProposalStatusPending {
		return domain.NewValidationError("proposal is not pending")
	}
	proposal.Status = collabModels.ProposalStatusRejected
	proposal.DecidedByUserID = &decision.DecidedByUserID
	proposal.DecidedAt = &decision.DecidedAt
	s.proposals[proposal.ID] = proposal
	return nil
}

func (s *fakeProposalStore) UpsertStatus(_ context.Context, proposalID uuid.UUID, status collabModels.ProposalStatus) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	proposal, ok := s.proposals[proposalID]
	if !ok {
		return nil
	}
	proposal.Status = status
	s.proposals[proposal.ID] = proposal
	return nil
}

func (s *fakeProposalStore) SetAcceptedAtOffset(_ context.Context, proposalID uuid.UUID, offset int, version int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	proposal, ok := s.proposals[proposalID]
	if !ok {
		return domain.NewNotFoundError("proposal", "proposal not found")
	}
	if proposal.OffsetVersion >= version {
		return nil
	}
	proposal.AcceptedAtOffset = &offset
	proposal.OffsetVersion = version
	s.proposals[proposal.ID] = proposal
	return nil
}

func (s *fakeProposalStore) CountRecentByDocumentAndStatus(
	_ context.Context,
	_ uuid.UUID,
	_ collabModels.ProposalStatus,
	_ time.Time,
) (int, error) {
	return 0, nil
}

type fakeProposalRuntime struct {
	mu            sync.Mutex
	failures      map[string]error
	calls         []string
	applyHook     func(documentID uuid.UUID, update []byte)
	currentActive int
	maxActive     int
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

func (r *fakeProposalRuntime) ApplyUpdate(_ context.Context, documentID uuid.UUID, update []byte, _ string) error {
	key := string(update)
	r.mu.Lock()
	r.calls = append(r.calls, key)
	r.currentActive++
	if r.currentActive > r.maxActive {
		r.maxActive = r.currentActive
	}
	hook := r.applyHook
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		r.currentActive--
		r.mu.Unlock()
	}()

	if hook != nil {
		hook(documentID, update)
	}

	r.mu.Lock()
	err, ok := r.failures[key]
	r.mu.Unlock()
	if ok {
		return err
	}
	return nil
}

func (r *fakeProposalRuntime) maxInFlight() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.maxActive
}

func (r *fakeProposalRuntime) callCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func (r *fakeProposalRuntime) GetStateSnapshot(_ context.Context, _ uuid.UUID) ([]byte, bool, error) {
	return nil, false, nil
}

func (r *fakeProposalRuntime) GetCurrentState(_ context.Context, _ uuid.UUID) ([]byte, error) {
	return nil, nil
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

func boolPtr(v bool) *bool {
	return &v
}

// --- Arbiter tests ---

// fakeArbiter implements collabSvc.AgentArbiter for testing.
type fakeArbiter struct {
	decision  collabSvc.ArbiterDecision
	callCount int
}

func (a *fakeArbiter) Evaluate(_ context.Context, _ collabSvc.ArbiterInput) collabSvc.ArbiterDecision {
	a.callCount++
	return a.decision
}

// panicArbiter panics on Evaluate, used to test panic recovery.
type panicArbiter struct{}

func (a *panicArbiter) Evaluate(_ context.Context, _ collabSvc.ArbiterInput) collabSvc.ArbiterDecision {
	panic("arbiter blew up")
}

func TestProposalServiceCreateProposal_ArbiterForcesReview(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	runtime := newFakeProposalRuntime(nil)

	// Baseline auto-accept = true (agent override), but arbiter forces review.
	arbiter := &fakeArbiter{
		decision: collabSvc.ArbiterDecision{
			Verdict: collabSvc.ArbiterVerdictRequireReview,
			Reason:  "test: force review",
		},
	}
	autoAccept := &fakeAutoAcceptPolicyStore{}

	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, arbiter, true)
	created, err := svc.CreateProposal(ctx, collabSvc.CreateProposalRequest{
		DocumentID:        uuid.New(),
		Source:            collabModels.ProposalSourceAI,
		ProducerAgentType: "writer",
		ThreadID:          uuid.New(),
		AgentRunID:        uuid.New(),
		YjsUpdate:         []byte("arbiter-review-update"),
		CreatedByUserID:   uuid.New(),
		AgentAutoAccept:   boolPtr(true),
	})
	if err != nil {
		t.Fatalf("create proposal: %v", err)
	}
	if created.Status != collabModels.ProposalStatusPending {
		t.Fatalf("expected pending (review-required) status, got %s", created.Status)
	}
	if runtime.callCount() != 0 {
		t.Fatalf("expected no runtime apply when arbiter forces review, got %d", runtime.callCount())
	}
	if arbiter.callCount != 1 {
		t.Fatalf("expected arbiter called once, got %d", arbiter.callCount)
	}
}

func TestProposalServiceCreateProposal_ArbiterPassThroughPreservesAutoAccept(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	runtime := newFakeProposalRuntime(nil)
	arbiter := &fakeArbiter{
		decision: collabSvc.ArbiterDecision{
			Verdict: collabSvc.ArbiterVerdictPassThrough,
			Reason:  "no opinion",
		},
	}
	autoAccept := &fakeAutoAcceptPolicyStore{}

	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, arbiter, true)
	created, err := svc.CreateProposal(ctx, collabSvc.CreateProposalRequest{
		DocumentID:        uuid.New(),
		Source:            collabModels.ProposalSourceAI,
		ProducerAgentType: "writer",
		ThreadID:          uuid.New(),
		AgentRunID:        uuid.New(),
		YjsUpdate:         []byte("arbiter-pass-update"),
		CreatedByUserID:   uuid.New(),
	})
	if err != nil {
		t.Fatalf("create proposal: %v", err)
	}
	if created.Status != collabModels.ProposalStatusAccepted {
		t.Fatalf("expected auto-accepted status, got %s", created.Status)
	}
	if runtime.callCount() != 1 {
		t.Fatalf("expected one runtime apply for auto-accept, got %d", runtime.callCount())
	}
	if arbiter.callCount != 1 {
		t.Fatalf("expected arbiter called once, got %d", arbiter.callCount)
	}
}

func TestProposalServiceCreateProposal_ArbiterNotCalledForNonAI(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	runtime := newFakeProposalRuntime(nil)
	arbiter := &fakeArbiter{
		decision: collabSvc.ArbiterDecision{
			Verdict: collabSvc.ArbiterVerdictRequireReview,
			Reason:  "should not be called",
		},
	}
	autoAccept := &fakeAutoAcceptPolicyStore{}

	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, arbiter, true)
	created, err := svc.CreateProposal(ctx, collabSvc.CreateProposalRequest{
		DocumentID:        uuid.New(),
		Source:            collabModels.ProposalSourceUserSuggestion,
		ProducerAgentType: "",
		ThreadID:          uuid.New(),
		AgentRunID:        uuid.New(),
		YjsUpdate:         []byte("human-update"),
		CreatedByUserID:   uuid.New(),
	})
	if err != nil {
		t.Fatalf("create proposal: %v", err)
	}
	// Non-AI proposals should still auto-accept (system default = true) and skip arbiter.
	if created.Status != collabModels.ProposalStatusAccepted {
		t.Fatalf("expected auto-accepted for non-AI, got %s", created.Status)
	}
	if arbiter.callCount != 0 {
		t.Fatalf("expected arbiter NOT called for non-AI source, got %d calls", arbiter.callCount)
	}
}

func TestProposalServiceCreateProposal_ArbiterNotCalledWhenBaselineReview(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	runtime := newFakeProposalRuntime(nil)
	arbiter := &fakeArbiter{
		decision: collabSvc.ArbiterDecision{
			Verdict: collabSvc.ArbiterVerdictAllow,
			Reason:  "should not matter",
		},
	}
	autoAccept := &fakeAutoAcceptPolicyStore{}

	// System default = false, agent override = false -> baseline is already review-required.
	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, arbiter, false)
	created, err := svc.CreateProposal(ctx, collabSvc.CreateProposalRequest{
		DocumentID:        uuid.New(),
		Source:            collabModels.ProposalSourceAI,
		ProducerAgentType: "writer",
		ThreadID:          uuid.New(),
		AgentRunID:        uuid.New(),
		YjsUpdate:         []byte("baseline-review-update"),
		CreatedByUserID:   uuid.New(),
		AgentAutoAccept:   boolPtr(false),
	})
	if err != nil {
		t.Fatalf("create proposal: %v", err)
	}
	if created.Status != collabModels.ProposalStatusPending {
		t.Fatalf("expected pending, got %s", created.Status)
	}
	// Arbiter should not be called when baseline is already review-required.
	if arbiter.callCount != 0 {
		t.Fatalf("expected arbiter NOT called when baseline is review, got %d calls", arbiter.callCount)
	}
}

func TestProposalServiceCreateProposal_ArbiterPanicDegradesToReview(t *testing.T) {
	ctx := context.Background()
	stores := newFakeProposalStore()
	runtime := newFakeProposalRuntime(nil)
	autoAccept := &fakeAutoAcceptPolicyStore{}

	svc := NewProposalService(stores, fakeTxManager{}, runtime, autoAccept, &panicArbiter{}, true)
	created, err := svc.CreateProposal(ctx, collabSvc.CreateProposalRequest{
		DocumentID:        uuid.New(),
		Source:            collabModels.ProposalSourceAI,
		ProducerAgentType: "writer",
		ThreadID:          uuid.New(),
		AgentRunID:        uuid.New(),
		YjsUpdate:         []byte("panic-update"),
		CreatedByUserID:   uuid.New(),
	})
	if err != nil {
		t.Fatalf("create proposal should succeed despite arbiter panic: %v", err)
	}
	// Panic degrades to review-required: proposal should NOT be auto-accepted.
	if created.Status != collabModels.ProposalStatusPending {
		t.Fatalf("expected pending after arbiter panic, got %s", created.Status)
	}
	if runtime.callCount() != 0 {
		t.Fatalf("expected no runtime apply after arbiter panic, got %d", runtime.callCount())
	}
}

// --- composeProposalUpdates tests ---

func TestComposeProposalUpdates_PositionalEdits(t *testing.T) {
	baseContent := "Line 1\nLine 2\nLine 3"
	baseState := buildDocState(t, baseContent)

	// Proposal 1: replace "Line 1" with "Modified Line 1"
	update1, err := TextToUpdate(baseState, "Modified Line 1\nLine 2\nLine 3", &TextEdit{
		OldText: "Line 1", NewText: "Modified Line 1", Position: 0,
	})
	if err != nil {
		t.Fatalf("TextToUpdate proposal 1: %v", err)
	}

	// Build projected state for proposal 2 (base + proposal 1)
	projState := applyUpdateToState(t, baseState, update1)

	// Proposal 2: replace "Line 3" with "Modified Line 3"
	update2, err := TextToUpdate(projState, "Modified Line 1\nLine 2\nModified Line 3", &TextEdit{
		OldText:  "Line 3",
		NewText:  "Modified Line 3",
		Position: len("Modified Line 1\nLine 2\n"),
	})
	if err != nil {
		t.Fatalf("TextToUpdate proposal 2: %v", err)
	}

	// Compose
	proposals := []groupAcceptValidProposal{
		{proposal: collabModels.Proposal{YjsUpdate: update1}},
		{proposal: collabModels.Proposal{YjsUpdate: update2}},
	}
	composite, perErrors, err := composeProposalUpdates(baseState, proposals)
	if err != nil {
		t.Fatalf("composeProposalUpdates: %v", err)
	}
	for i, e := range perErrors {
		if e != nil {
			t.Fatalf("proposal %d error: %v", i, e)
		}
	}
	if composite == nil {
		t.Fatal("expected non-nil composite update")
	}

	// Apply composite to a fresh doc and verify content
	resultText := applyAndRead(t, baseState, composite)
	expected := "Modified Line 1\nLine 2\nModified Line 3"
	if resultText != expected {
		t.Fatalf("content mismatch:\nexpected: %q\ngot:      %q", expected, resultText)
	}
}

func TestComposeProposalUpdates_ThreeProposalsWithFullDocReplacement(t *testing.T) {
	baseContent := "Chapter 1\n\nOnce upon a time.\n\nThe end."
	baseState := buildDocState(t, baseContent)

	// Proposal 1: targeted edit - replace "Once upon a time." with "It was a dark night."
	update1, err := TextToUpdate(baseState, "Chapter 1\n\nIt was a dark night.\n\nThe end.", &TextEdit{
		OldText:  "Once upon a time.",
		NewText:  "It was a dark night.",
		Position: len("Chapter 1\n\n"),
	})
	if err != nil {
		t.Fatalf("TextToUpdate proposal 1: %v", err)
	}

	// Build projected state for proposal 2
	proj1 := applyUpdateToState(t, baseState, update1)

	// Proposal 2: full-doc replacement (edit=nil)
	update2, err := TextToUpdate(proj1, "Chapter 1\n\nIt was a dark night.\n\nTo be continued.", nil)
	if err != nil {
		t.Fatalf("TextToUpdate proposal 2: %v", err)
	}

	// Build projected state for proposal 3
	proj2 := applyUpdateToState(t, proj1, update2)

	// Proposal 3: targeted edit on the result
	update3, err := TextToUpdate(proj2, "Chapter ONE\n\nIt was a dark night.\n\nTo be continued.", &TextEdit{
		OldText:  "Chapter 1",
		NewText:  "Chapter ONE",
		Position: 0,
	})
	if err != nil {
		t.Fatalf("TextToUpdate proposal 3: %v", err)
	}

	proposals := []groupAcceptValidProposal{
		{proposal: collabModels.Proposal{YjsUpdate: update1}},
		{proposal: collabModels.Proposal{YjsUpdate: update2}},
		{proposal: collabModels.Proposal{YjsUpdate: update3}},
	}
	composite, perErrors, err := composeProposalUpdates(baseState, proposals)
	if err != nil {
		t.Fatalf("composeProposalUpdates: %v", err)
	}
	for i, e := range perErrors {
		if e != nil {
			t.Fatalf("proposal %d error: %v", i, e)
		}
	}
	if composite == nil {
		t.Fatal("expected non-nil composite update")
	}

	resultText := applyAndRead(t, baseState, composite)
	expected := "Chapter ONE\n\nIt was a dark night.\n\nTo be continued."
	if resultText != expected {
		t.Fatalf("content mismatch:\nexpected: %q\ngot:      %q", expected, resultText)
	}
}

func TestComposeProposalUpdates_MultipleIndependentEdits(t *testing.T) {
	// Two proposals editing different sections of the same document.
	// Both generated against sequential projected states (real scenario).
	baseState := buildDocState(t, "hello world foo bar")

	update1, err := TextToUpdate(baseState, "HELLO world foo bar", &TextEdit{
		OldText: "hello", NewText: "HELLO", Position: 0,
	})
	if err != nil {
		t.Fatalf("TextToUpdate 1: %v", err)
	}

	proj1 := applyUpdateToState(t, baseState, update1)
	update2, err := TextToUpdate(proj1, "HELLO world FOO bar", &TextEdit{
		OldText: "foo", NewText: "FOO",
		Position: len("HELLO world "),
	})
	if err != nil {
		t.Fatalf("TextToUpdate 2: %v", err)
	}

	proposals := []groupAcceptValidProposal{
		{proposal: collabModels.Proposal{YjsUpdate: update1}},
		{proposal: collabModels.Proposal{YjsUpdate: update2}},
	}
	composite, perErrors, err := composeProposalUpdates(baseState, proposals)
	if err != nil {
		t.Fatalf("composeProposalUpdates: %v", err)
	}
	for i, e := range perErrors {
		if e != nil {
			t.Fatalf("proposal %d error: %v", i, e)
		}
	}
	if composite == nil {
		t.Fatal("expected non-nil composite")
	}

	resultText := applyAndRead(t, baseState, composite)
	expected := "HELLO world FOO bar"
	if resultText != expected {
		t.Fatalf("expected %q, got %q", expected, resultText)
	}
}

func TestComposeProposalUpdates_SingleProposal(t *testing.T) {
	baseState := buildDocState(t, "hello")
	update, err := TextToUpdate(baseState, "hello world", nil)
	if err != nil {
		t.Fatalf("TextToUpdate: %v", err)
	}

	proposals := []groupAcceptValidProposal{
		{proposal: collabModels.Proposal{YjsUpdate: update}},
	}
	composite, perErrors, err := composeProposalUpdates(baseState, proposals)
	if err != nil {
		t.Fatalf("composeProposalUpdates: %v", err)
	}
	if perErrors[0] != nil {
		t.Fatalf("unexpected error: %v", perErrors[0])
	}
	if composite == nil {
		t.Fatal("expected non-nil composite")
	}

	resultText := applyAndRead(t, baseState, composite)
	if resultText != "hello world" {
		t.Fatalf("expected %q, got %q", "hello world", resultText)
	}
}

func TestComposeProposalUpdates_EmptyBaseState(t *testing.T) {
	// Nil base state should work (empty doc).
	update, err := TextToUpdate(nil, "new content", nil)
	if err != nil {
		t.Fatalf("TextToUpdate: %v", err)
	}

	proposals := []groupAcceptValidProposal{
		{proposal: collabModels.Proposal{YjsUpdate: update}},
	}
	composite, perErrors, err := composeProposalUpdates(nil, proposals)
	if err != nil {
		t.Fatalf("composeProposalUpdates: %v", err)
	}
	if perErrors[0] != nil {
		t.Fatalf("expected no error, got: %v", perErrors[0])
	}
	if composite == nil {
		t.Fatal("expected non-nil composite")
	}

	resultText := applyAndRead(t, nil, composite)
	if resultText != "new content" {
		t.Fatalf("expected %q, got %q", "new content", resultText)
	}
}
