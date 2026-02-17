package collab

import (
	"context"
	"testing"

	"github.com/google/uuid"

	collabModels "meridian/internal/domain/models/collab"
	collabSvc "meridian/internal/domain/services/collab"
)

func TestSizeThresholdStrategy_Name(t *testing.T) {
	s := NewSizeThresholdStrategy(1024, 51200)
	if s.Name() != "size_threshold" {
		t.Fatalf("expected name 'size_threshold', got %q", s.Name())
	}
}

func TestSizeThresholdStrategy_Evaluate(t *testing.T) {
	const small = 1024
	const large = 51200

	tests := []struct {
		name         string
		size         int
		wantVerdict  collabSvc.ArbiterVerdict
	}{
		{"zero bytes passes through", 0, collabSvc.ArbiterVerdictPassThrough},
		{"small update passes through", 512, collabSvc.ArbiterVerdictPassThrough},
		{"exactly at small threshold passes through", small, collabSvc.ArbiterVerdictPassThrough},
		{"medium update passes through", 25000, collabSvc.ArbiterVerdictPassThrough},
		{"exactly at large threshold passes through", large, collabSvc.ArbiterVerdictPassThrough},
		{"one byte over large requires review", large + 1, collabSvc.ArbiterVerdictRequireReview},
		{"very large requires review", 200000, collabSvc.ArbiterVerdictRequireReview},
	}

	s := NewSizeThresholdStrategy(small, large)
	ctx := context.Background()

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := collabSvc.ArbiterInput{
				DocumentID:    uuid.New(),
				Source:        collabModels.ProposalSourceAI,
				YjsUpdateSize: tt.size,
			}
			decision := s.Evaluate(ctx, input)
			if decision.Verdict != tt.wantVerdict {
				t.Errorf("size=%d: got verdict %q, want %q", tt.size, decision.Verdict, tt.wantVerdict)
			}
		})
	}
}

func TestSizeThresholdStrategy_CustomThresholds(t *testing.T) {
	s := NewSizeThresholdStrategy(100, 500)
	ctx := context.Background()
	input := collabSvc.ArbiterInput{
		DocumentID:    uuid.New(),
		Source:        collabModels.ProposalSourceAI,
		YjsUpdateSize: 501,
	}
	decision := s.Evaluate(ctx, input)
	if decision.Verdict != collabSvc.ArbiterVerdictRequireReview {
		t.Errorf("expected require_review for size 501 with threshold 500, got %q", decision.Verdict)
	}

	input.YjsUpdateSize = 500
	decision = s.Evaluate(ctx, input)
	if decision.Verdict != collabSvc.ArbiterVerdictPassThrough {
		t.Errorf("expected pass_through for size 500 with threshold 500, got %q", decision.Verdict)
	}
}

func TestSizeThresholdStrategy_ReasonContainsSize(t *testing.T) {
	s := NewSizeThresholdStrategy(1024, 51200)
	ctx := context.Background()
	input := collabSvc.ArbiterInput{
		DocumentID:    uuid.New(),
		Source:        collabModels.ProposalSourceAI,
		YjsUpdateSize: 60000,
	}
	decision := s.Evaluate(ctx, input)
	if decision.Reason == "" {
		t.Error("expected non-empty reason for require_review verdict")
	}
}
