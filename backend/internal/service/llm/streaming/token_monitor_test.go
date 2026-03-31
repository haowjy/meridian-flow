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

func TestCheckBudget_BelowCollapse(t *testing.T) {
	// 59% usage — all flags must be false
	monitor := newStubMonitor(0.59, 200_000, 0)

	check, err := monitor.CheckBudget(context.Background(), tokens.EstimateRequest{Model: "test-model"})
	if err != nil {
		t.Fatalf("CheckBudget returned unexpected error: %v", err)
	}

	if check.ShouldCollapse {
		t.Errorf("ShouldCollapse = true at 59%%, want false")
	}
	if check.ShouldCompact {
		t.Errorf("ShouldCompact = true at 59%%, want false")
	}
	if check.ShouldWarn {
		t.Errorf("ShouldWarn = true at 59%%, want false")
	}
}

func TestCheckBudget_AtCollapse(t *testing.T) {
	// Exactly 60% — only ShouldCollapse must be true
	monitor := newStubMonitor(0.60, 200_000, 0)

	check, err := monitor.CheckBudget(context.Background(), tokens.EstimateRequest{Model: "test-model"})
	if err != nil {
		t.Fatalf("CheckBudget returned unexpected error: %v", err)
	}

	if !check.ShouldCollapse {
		t.Errorf("ShouldCollapse = false at 60%%, want true")
	}
	if check.ShouldCompact {
		t.Errorf("ShouldCompact = true at 60%%, want false")
	}
	if check.ShouldWarn {
		t.Errorf("ShouldWarn = true at 60%%, want false")
	}
}

func TestCheckBudget_BetweenCollapseAndCompact(t *testing.T) {
	// 75% — ShouldCollapse true, ShouldCompact false
	monitor := newStubMonitor(0.75, 200_000, 0)

	check, err := monitor.CheckBudget(context.Background(), tokens.EstimateRequest{Model: "test-model"})
	if err != nil {
		t.Fatalf("CheckBudget returned unexpected error: %v", err)
	}

	if !check.ShouldCollapse {
		t.Errorf("ShouldCollapse = false at 75%%, want true")
	}
	if check.ShouldCompact {
		t.Errorf("ShouldCompact = true at 75%%, want false")
	}
	if check.ShouldWarn {
		t.Errorf("ShouldWarn = true at 75%%, want false")
	}
}

func TestCheckBudget_AtCompact(t *testing.T) {
	// Exactly 80% — ShouldCollapse and ShouldCompact true, ShouldWarn false
	monitor := newStubMonitor(0.80, 200_000, 0)

	check, err := monitor.CheckBudget(context.Background(), tokens.EstimateRequest{Model: "test-model"})
	if err != nil {
		t.Fatalf("CheckBudget returned unexpected error: %v", err)
	}

	if !check.ShouldCollapse {
		t.Errorf("ShouldCollapse = false at 80%%, want true")
	}
	if !check.ShouldCompact {
		t.Errorf("ShouldCompact = false at 80%%, want true")
	}
	if check.ShouldWarn {
		t.Errorf("ShouldWarn = true at 80%%, want false")
	}
}

func TestCheckBudget_BetweenCompactAndWarn(t *testing.T) {
	// 85% — ShouldCollapse and ShouldCompact true, ShouldWarn false
	monitor := newStubMonitor(0.85, 200_000, 0)

	check, err := monitor.CheckBudget(context.Background(), tokens.EstimateRequest{Model: "test-model"})
	if err != nil {
		t.Fatalf("CheckBudget returned unexpected error: %v", err)
	}

	if !check.ShouldCollapse {
		t.Errorf("ShouldCollapse = false at 85%%, want true")
	}
	if !check.ShouldCompact {
		t.Errorf("ShouldCompact = false at 85%%, want true")
	}
	if check.ShouldWarn {
		t.Errorf("ShouldWarn = true at 85%%, want false")
	}
}

func TestCheckBudget_AtWarn(t *testing.T) {
	// Exactly 90% — all flags must be true
	monitor := newStubMonitor(0.90, 200_000, 0)

	check, err := monitor.CheckBudget(context.Background(), tokens.EstimateRequest{Model: "test-model"})
	if err != nil {
		t.Fatalf("CheckBudget returned unexpected error: %v", err)
	}

	if !check.ShouldCollapse {
		t.Errorf("ShouldCollapse = false at 90%%, want true")
	}
	if !check.ShouldCompact {
		t.Errorf("ShouldCompact = false at 90%%, want true")
	}
	if !check.ShouldWarn {
		t.Errorf("ShouldWarn = false at 90%%, want true")
	}
}

func TestCheckBudget_Above100Percent(t *testing.T) {
	// 110% — all flags must be true (context window exceeded)
	monitor := newStubMonitor(1.10, 200_000, 0)

	check, err := monitor.CheckBudget(context.Background(), tokens.EstimateRequest{Model: "test-model"})
	if err != nil {
		t.Fatalf("CheckBudget returned unexpected error: %v", err)
	}

	if !check.ShouldCollapse {
		t.Errorf("ShouldCollapse = false at 110%%, want true")
	}
	if !check.ShouldCompact {
		t.Errorf("ShouldCompact = false at 110%%, want true")
	}
	if !check.ShouldWarn {
		t.Errorf("ShouldWarn = false at 110%%, want true")
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
