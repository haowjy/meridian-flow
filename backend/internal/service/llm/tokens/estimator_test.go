package tokens

import (
	"context"
	"testing"

	"meridian/internal/capabilities"
)

// newTestEstimator creates a TokenEstimator for tests, panicking on failure.
// Pass capRegistry=nil to test the no-capability path.
func newTestEstimator(t *testing.T, capRegistry *capabilities.Registry) TokenEstimator {
	t.Helper()
	est, err := NewTiktokenEstimator(capRegistry)
	if err != nil {
		t.Fatalf("NewTiktokenEstimator: %v", err)
	}
	return est
}

// newTestCapRegistry creates a real capabilities.Registry backed by embedded YAML.
func newTestCapRegistry(t *testing.T) *capabilities.Registry {
	t.Helper()
	reg, err := capabilities.NewRegistry()
	if err != nil {
		t.Fatalf("capabilities.NewRegistry: %v", err)
	}
	return reg
}

// ---------------------------------------------------------------------------
// EstimateText — known token counts for cl100k_base
// ---------------------------------------------------------------------------

func TestEstimateText_KnownCounts(t *testing.T) {
	est := newTestEstimator(t, nil)

	cases := []struct {
		input string
		want  int
	}{
		// Verified against cl100k_base encoding
		{"", 0},
		{"the", 1},
		{"user", 1},
		{"assistant", 1},
		{"hello world", 2},
		{"Hello, world!", 4},
		{"You are a helpful assistant.", 6},
	}

	for _, tc := range cases {
		got := est.EstimateText(tc.input)
		if got != tc.want {
			t.Errorf("EstimateText(%q) = %d, want %d", tc.input, got, tc.want)
		}
	}
}

func TestEstimateText_EmptyString(t *testing.T) {
	est := newTestEstimator(t, nil)
	if got := est.EstimateText(""); got != 0 {
		t.Errorf("EstimateText(\"\") = %d, want 0", got)
	}
}

// ---------------------------------------------------------------------------
// EstimateRequest — token breakdown correctness
// ---------------------------------------------------------------------------

func TestEstimateRequest_SystemTokensOnly(t *testing.T) {
	est := newTestEstimator(t, nil)

	req := EstimateRequest{
		Model:        "unknown-model",
		SystemPrompt: "You are a helpful assistant.", // 6 tokens
	}

	result, err := est.EstimateRequest(context.Background(), req)
	if err != nil {
		t.Fatalf("EstimateRequest: %v", err)
	}

	if result.SystemTokens != 6 {
		t.Errorf("SystemTokens = %d, want 6", result.SystemTokens)
	}
	if result.MessageTokens != 0 {
		t.Errorf("MessageTokens = %d, want 0", result.MessageTokens)
	}
	if result.ToolTokens != 0 {
		t.Errorf("ToolTokens = %d, want 0", result.ToolTokens)
	}
	if result.TotalInput != 6 {
		t.Errorf("TotalInput = %d, want 6", result.TotalInput)
	}
}

func TestEstimateRequest_MessageTokens(t *testing.T) {
	est := newTestEstimator(t, nil)

	// "user" = 1 token, "hello world" = 2 tokens, padding = 4 → 7 per message
	req := EstimateRequest{
		Model: "unknown-model",
		Messages: []Message{
			{Role: "user", Content: "hello world"},
		},
	}

	result, err := est.EstimateRequest(context.Background(), req)
	if err != nil {
		t.Fatalf("EstimateRequest: %v", err)
	}

	// 1 (role) + 2 (content) + 4 (padding) = 7
	if result.MessageTokens != 7 {
		t.Errorf("MessageTokens = %d, want 7", result.MessageTokens)
	}
	if result.TotalInput != 7 {
		t.Errorf("TotalInput = %d, want 7", result.TotalInput)
	}
}

func TestEstimateRequest_MultipleMessages(t *testing.T) {
	est := newTestEstimator(t, nil)

	req := EstimateRequest{
		Model: "unknown-model",
		Messages: []Message{
			{Role: "user", Content: "hello world"},        // 1+2+4 = 7
			{Role: "assistant", Content: "Hello, world!"}, // 1+4+4 = 9
		},
	}

	result, err := est.EstimateRequest(context.Background(), req)
	if err != nil {
		t.Fatalf("EstimateRequest: %v", err)
	}

	// 7 + 9 = 16
	if result.MessageTokens != 16 {
		t.Errorf("MessageTokens = %d, want 16", result.MessageTokens)
	}
}

func TestEstimateRequest_ToolTokens(t *testing.T) {
	est := newTestEstimator(t, nil)

	// "search" = 1 token, "the" = 1 token, "{}" = 1 token → 3 total
	req := EstimateRequest{
		Model: "unknown-model",
		Tools: []Tool{
			{Name: "search", Description: "the", InputSchema: "{}"},
		},
	}

	result, err := est.EstimateRequest(context.Background(), req)
	if err != nil {
		t.Fatalf("EstimateRequest: %v", err)
	}

	if result.ToolTokens != 3 {
		t.Errorf("ToolTokens = %d, want 3", result.ToolTokens)
	}
}

func TestEstimateRequest_TotalInputIsSum(t *testing.T) {
	est := newTestEstimator(t, nil)

	req := EstimateRequest{
		Model:        "unknown-model",
		SystemPrompt: "You are a helpful assistant.", // 6
		Messages: []Message{
			{Role: "user", Content: "hello world"}, // 1+2+4 = 7
		},
		Tools: []Tool{
			{Name: "search", Description: "the", InputSchema: "{}"}, // 1+1+1 = 3
		},
	}

	result, err := est.EstimateRequest(context.Background(), req)
	if err != nil {
		t.Fatalf("EstimateRequest: %v", err)
	}

	wantTotal := result.SystemTokens + result.MessageTokens + result.ToolTokens
	if result.TotalInput != wantTotal {
		t.Errorf("TotalInput = %d, want SystemTokens(%d) + MessageTokens(%d) + ToolTokens(%d) = %d",
			result.TotalInput,
			result.SystemTokens, result.MessageTokens, result.ToolTokens,
			wantTotal)
	}
}

// ---------------------------------------------------------------------------
// EstimateRequest — capability registry integration
// ---------------------------------------------------------------------------

func TestEstimateRequest_KnownModel_ContextWindow(t *testing.T) {
	capReg := newTestCapRegistry(t)
	est := newTestEstimator(t, capReg)

	// claude-haiku-4-5: context_window=200000, max_output=64000
	req := EstimateRequest{
		Model:        "claude-haiku-4-5",
		SystemPrompt: "You are a helpful assistant.", // 6 tokens
	}

	result, err := est.EstimateRequest(context.Background(), req)
	if err != nil {
		t.Fatalf("EstimateRequest: %v", err)
	}

	if result.ContextWindow != 200000 {
		t.Errorf("ContextWindow = %d, want 200000", result.ContextWindow)
	}
	if result.MaxOutput != 64000 {
		t.Errorf("MaxOutput = %d, want 64000", result.MaxOutput)
	}
}

func TestEstimateRequest_UnknownModel_ZeroCapabilities(t *testing.T) {
	capReg := newTestCapRegistry(t)
	est := newTestEstimator(t, capReg)

	req := EstimateRequest{
		Model:        "no-such-model-xyz",
		SystemPrompt: "hello world",
	}

	result, err := est.EstimateRequest(context.Background(), req)
	if err != nil {
		t.Fatalf("EstimateRequest: %v", err)
	}

	if result.ContextWindow != 0 {
		t.Errorf("ContextWindow = %d, want 0 for unknown model", result.ContextWindow)
	}
	if result.MaxOutput != 0 {
		t.Errorf("MaxOutput = %d, want 0 for unknown model", result.MaxOutput)
	}
}

func TestEstimateRequest_NilRegistry_ZeroCapabilities(t *testing.T) {
	est := newTestEstimator(t, nil)

	req := EstimateRequest{
		Model:        "claude-haiku-4-5",
		SystemPrompt: "hello world",
	}

	result, err := est.EstimateRequest(context.Background(), req)
	if err != nil {
		t.Fatalf("EstimateRequest: %v", err)
	}

	if result.ContextWindow != 0 {
		t.Errorf("ContextWindow = %d, want 0 when registry is nil", result.ContextWindow)
	}
}

// ---------------------------------------------------------------------------
// EstimateRequest — RemainingInput and UsagePercent
// ---------------------------------------------------------------------------

func TestEstimateRequest_RemainingInput(t *testing.T) {
	capReg := newTestCapRegistry(t)
	est := newTestEstimator(t, capReg)

	// claude-haiku-4-5: context_window=200000, max_output=64000
	// "hello world" = 2 tokens
	req := EstimateRequest{
		Model:        "claude-haiku-4-5",
		SystemPrompt: "hello world",
	}

	result, err := est.EstimateRequest(context.Background(), req)
	if err != nil {
		t.Fatalf("EstimateRequest: %v", err)
	}

	// RemainingInput = ContextWindow - TotalInput - MaxOutput
	wantRemaining := result.ContextWindow - result.TotalInput - result.MaxOutput
	if result.RemainingInput != wantRemaining {
		t.Errorf("RemainingInput = %d, want %d (ContextWindow=%d - TotalInput=%d - MaxOutput=%d)",
			result.RemainingInput, wantRemaining,
			result.ContextWindow, result.TotalInput, result.MaxOutput)
	}
}

func TestEstimateRequest_UsagePercent(t *testing.T) {
	capReg := newTestCapRegistry(t)
	est := newTestEstimator(t, capReg)

	// claude-haiku-4-5: context_window=200000, max_output=64000
	// "hello world" = 2 tokens
	req := EstimateRequest{
		Model:        "claude-haiku-4-5",
		SystemPrompt: "hello world",
	}

	result, err := est.EstimateRequest(context.Background(), req)
	if err != nil {
		t.Fatalf("EstimateRequest: %v", err)
	}

	// UsagePercent = TotalInput / (ContextWindow - MaxOutput)
	// = 2 / (200000 - 64000) = 2 / 136000 ≈ 0.00001471
	wantPercent := float64(result.TotalInput) / float64(result.ContextWindow-result.MaxOutput)
	if result.UsagePercent != wantPercent {
		t.Errorf("UsagePercent = %f, want %f", result.UsagePercent, wantPercent)
	}
	if result.UsagePercent < 0 || result.UsagePercent > 1 {
		t.Errorf("UsagePercent = %f is out of expected [0,1] range for small input", result.UsagePercent)
	}
}

func TestEstimateRequest_UsagePercent_ZeroForUnknownModel(t *testing.T) {
	capReg := newTestCapRegistry(t)
	est := newTestEstimator(t, capReg)

	req := EstimateRequest{
		Model:        "no-such-model-xyz",
		SystemPrompt: "hello world",
	}

	result, err := est.EstimateRequest(context.Background(), req)
	if err != nil {
		t.Fatalf("EstimateRequest: %v", err)
	}

	// denominator = 0 - 0 = 0, so UsagePercent should be 0
	if result.UsagePercent != 0 {
		t.Errorf("UsagePercent = %f, want 0 for unknown model (zero denominator)", result.UsagePercent)
	}
}
