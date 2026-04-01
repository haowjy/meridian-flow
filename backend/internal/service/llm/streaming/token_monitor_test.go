package streaming

import (
	"context"
	"fmt"
	"log/slog"
	"testing"

	"meridian/internal/service/llm/tokens"
)

// =============================================================================
// Mock TokenEstimator
// =============================================================================

// stubTokenEstimator returns a fixed TokenEstimate, allowing tests to control
// UsagePercent directly without involving tiktoken or a capability registry.
type stubTokenEstimator struct {
	estimate *tokens.TokenEstimate
	err      error
}

func (s *stubTokenEstimator) EstimateRequest(_ context.Context, _ tokens.EstimateRequest) (*tokens.TokenEstimate, error) {
	return s.estimate, s.err
}

func (s *stubTokenEstimator) EstimateText(_ string) int {
	return 0
}

// newStubMonitor builds a TokenMonitor backed by a stub estimator that returns
// the given usage fraction.
//
// contextWindow and maxOutput are used to infer TotalInput so that:
//
//	UsagePercent = TotalInput / (contextWindow - maxOutput) ≈ usageFraction
func newStubMonitor(usageFraction float64, contextWindow, maxOutput int) *TokenMonitor {
	denominator := contextWindow - maxOutput
	totalInput := int(usageFraction * float64(denominator))

	est := &stubTokenEstimator{
		estimate: &tokens.TokenEstimate{
			ContextWindow: contextWindow,
			MaxOutput:     maxOutput,
			TotalInput:    totalInput,
			UsagePercent:  usageFraction,
		},
	}
	return NewTokenMonitor(est, slog.Default())
}

// =============================================================================
// CheckBudget threshold tests
// =============================================================================

func TestCheckBudget_Thresholds(t *testing.T) {
	tests := []struct {
		name          string
		usageFraction float64
		wantCollapse  bool
		wantCompact   bool
		wantWarn      bool
	}{
		{name: "below collapse threshold keeps all flags false", usageFraction: 0.59},
		{name: "collapse threshold sets collapse only", usageFraction: 0.60, wantCollapse: true},
		{name: "between collapse and compact keeps compact false", usageFraction: 0.75, wantCollapse: true},
		{name: "compact threshold sets collapse and compact", usageFraction: 0.80, wantCollapse: true, wantCompact: true},
		{name: "between compact and warn keeps warn false", usageFraction: 0.85, wantCollapse: true, wantCompact: true},
		{name: "warn threshold sets all flags", usageFraction: 0.90, wantCollapse: true, wantCompact: true, wantWarn: true},
		{name: "usage above context window still sets all flags", usageFraction: 1.10, wantCollapse: true, wantCompact: true, wantWarn: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			monitor := newStubMonitor(tt.usageFraction, 200_000, 0)

			check, err := monitor.CheckBudget(context.Background(), tokens.EstimateRequest{Model: "test-model"})
			if err != nil {
				t.Fatalf("CheckBudget returned unexpected error: %v", err)
			}
			if check.ShouldCollapse != tt.wantCollapse {
				t.Fatalf("ShouldCollapse = %v, want %v at %.0f%%", check.ShouldCollapse, tt.wantCollapse, tt.usageFraction*100)
			}
			if check.ShouldCompact != tt.wantCompact {
				t.Fatalf("ShouldCompact = %v, want %v at %.0f%%", check.ShouldCompact, tt.wantCompact, tt.usageFraction*100)
			}
			if check.ShouldWarn != tt.wantWarn {
				t.Fatalf("ShouldWarn = %v, want %v at %.0f%%", check.ShouldWarn, tt.wantWarn, tt.usageFraction*100)
			}
		})
	}
}

func TestCheckBudget_UsagePercentPreserved(t *testing.T) {
	// Verify UsagePercent is preserved exactly in the returned BudgetCheck
	const fraction = 0.73
	monitor := newStubMonitor(fraction, 200_000, 0)

	check, err := monitor.CheckBudget(context.Background(), tokens.EstimateRequest{Model: "test-model"})
	if err != nil {
		t.Fatalf("CheckBudget returned unexpected error: %v", err)
	}

	if check.UsagePercent != fraction {
		t.Errorf("UsagePercent = %f, want %f", check.UsagePercent, fraction)
	}
}

// =============================================================================
// Unknown-model / zero-context-window guard
// =============================================================================

func TestCheckBudget_UnknownModel_ReturnsEmpty(t *testing.T) {
	// ContextWindow == 0 means model unknown; all flags must be false
	est := &stubTokenEstimator{
		estimate: &tokens.TokenEstimate{
			ContextWindow: 0,
			UsagePercent:  0,
		},
	}
	monitor := NewTokenMonitor(est, slog.Default())

	check, err := monitor.CheckBudget(context.Background(), tokens.EstimateRequest{Model: "unknown-model"})
	if err != nil {
		t.Fatalf("CheckBudget returned unexpected error: %v", err)
	}

	if check.ShouldCollapse || check.ShouldCompact || check.ShouldWarn {
		t.Errorf("expected all flags false for unknown model, got: collapse=%v compact=%v warn=%v",
			check.ShouldCollapse, check.ShouldCompact, check.ShouldWarn)
	}
}

// =============================================================================
// Estimator error propagation
// =============================================================================

func TestCheckBudget_EstimatorError_Propagated(t *testing.T) {
	est := &stubTokenEstimator{
		err: fmt.Errorf("encoding failure"),
	}
	monitor := NewTokenMonitor(est, slog.Default())

	_, err := monitor.CheckBudget(context.Background(), tokens.EstimateRequest{Model: "any-model"})
	if err == nil {
		t.Error("expected error from CheckBudget when estimator fails, got nil")
	}
}

// =============================================================================
// Flag additivity invariant
// =============================================================================

// TestCheckBudget_FlagAdditivity verifies the invariant that ShouldWarn ⊆ ShouldCompact ⊆ ShouldCollapse.
// A higher-severity flag being set must never occur without the lower-severity flag also being set.
func TestCheckBudget_FlagAdditivity(t *testing.T) {
	fractions := []float64{0.0, 0.30, 0.59, 0.60, 0.79, 0.80, 0.89, 0.90, 1.00, 1.10}

	for _, frac := range fractions {
		monitor := newStubMonitor(frac, 200_000, 0)
		check, err := monitor.CheckBudget(context.Background(), tokens.EstimateRequest{Model: "test"})
		if err != nil {
			t.Fatalf("CheckBudget(%v) returned error: %v", frac, err)
		}

		// ShouldWarn implies ShouldCompact
		if check.ShouldWarn && !check.ShouldCompact {
			t.Errorf("at %.0f%%: ShouldWarn=true but ShouldCompact=false (violates additivity)", frac*100)
		}
		// ShouldCompact implies ShouldCollapse
		if check.ShouldCompact && !check.ShouldCollapse {
			t.Errorf("at %.0f%%: ShouldCompact=true but ShouldCollapse=false (violates additivity)", frac*100)
		}
	}
}
