package tokens

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"
)

// FinalizeReason indicates why token finalization is being requested.
type FinalizeReason string

const (
	// ReasonCompletion indicates normal stream completion with provider metadata.
	ReasonCompletion FinalizeReason = "completion"

	// ReasonSoftCancel indicates user-initiated soft cancel (SSE stopped, draining for metadata).
	ReasonSoftCancel FinalizeReason = "soft_cancel"

	// ReasonHardCancel indicates hard cancel (context cancelled, Anthropic models).
	ReasonHardCancel FinalizeReason = "hard_cancel"

	// ReasonError indicates the stream ended due to an error (not a user cancel).
	ReasonError FinalizeReason = "error"

	// ReasonSoftCancelTimeout indicates soft cancel timeout fired before provider finished.
	ReasonSoftCancelTimeout FinalizeReason = "soft_cancel_timeout"
)

// ProviderTokens represents token counts sent by the provider in stream metadata.
type ProviderTokens struct {
	InputTokens  int
	OutputTokens int
}

// FinalizeRequest contains all information needed to finalize token counts for a turn.
type FinalizeRequest struct {
	TurnID         string          // Turn ID (for logging)
	Model          string          // Model ID being used
	GenerationID   string          // OpenRouter generation ID (for stats API query)
	CancelSnapshot string          // Accumulated text at cancel time (for estimation)
	Reason         FinalizeReason  // Why finalization is being requested
	ProviderTokens *ProviderTokens // Token counts from provider metadata (may be nil or zero)
}

// TokenResult contains the finalized token counts and metadata about how they were obtained.
type TokenResult struct {
	InputTokens  int
	OutputTokens int
	IsFinal      bool   // True if tokens came from provider/API, false if estimated
	Source       string // "provider" | "openrouter_api" | "estimator" | "none"
}

// TokenFinalizer determines the final token counts for a turn using a strategy chain.
// It centralizes the decision logic that was previously scattered across executor methods.
type TokenFinalizer interface {
	// Finalize returns the best available token counts for the given request.
	// Strategy chain:
	//   1. If ProviderTokens present and non-zero -> use directly
	//   2. If OpenRouter model + GenerationID -> query stats API
	//   3. If estimator supports model + CancelSnapshot present -> estimate
	//   4. Fallback -> return 0 with IsFinal=false
	Finalize(ctx context.Context, req FinalizeRequest) (*TokenResult, error)
}

// DefaultTokenFinalizer implements TokenFinalizer with the standard strategy chain.
type DefaultTokenFinalizer struct {
	estimator        TokenEstimator // For estimating tokens from text
	openRouterAPIKey string         // For querying OpenRouter generation stats
	httpClient       *http.Client   // Reused HTTP client for connection pooling
	logger           *slog.Logger
}

// NewDefaultTokenFinalizer creates a new TokenFinalizer with the given dependencies.
func NewDefaultTokenFinalizer(
	estimator TokenEstimator,
	openRouterAPIKey string,
	logger *slog.Logger,
) *DefaultTokenFinalizer {
	return &DefaultTokenFinalizer{
		estimator:        estimator,
		openRouterAPIKey: openRouterAPIKey,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:       10,
				IdleConnTimeout:    90 * time.Second,
				DisableCompression: true,
			},
		},
		logger: logger,
	}
}

// Finalize implements TokenFinalizer.Finalize with the strategy chain.
func (f *DefaultTokenFinalizer) Finalize(ctx context.Context, req FinalizeRequest) (*TokenResult, error) {
	// Strategy 1: Use provider-sent tokens if present and non-zero
	if req.ProviderTokens != nil && (req.ProviderTokens.InputTokens > 0 || req.ProviderTokens.OutputTokens > 0) {
		f.logger.Debug("using provider tokens",
			"turn_id", req.TurnID,
			"input_tokens", req.ProviderTokens.InputTokens,
			"output_tokens", req.ProviderTokens.OutputTokens,
			"reason", req.Reason,
		)
		return &TokenResult{
			InputTokens:  req.ProviderTokens.InputTokens,
			OutputTokens: req.ProviderTokens.OutputTokens,
			IsFinal:      true,
			Source:       "provider",
		}, nil
	}

	// Strategy 2: Query OpenRouter generation stats API if available
	if f.openRouterAPIKey != "" && req.GenerationID != "" {
		stats, err := f.queryOpenRouterGenerationStats(ctx, req.GenerationID)
		if err == nil && (stats.InputTokens > 0 || stats.OutputTokens > 0) {
			f.logger.Info("using OpenRouter generation stats",
				"turn_id", req.TurnID,
				"input_tokens", stats.InputTokens,
				"output_tokens", stats.OutputTokens,
				"generation_id", req.GenerationID,
				"reason", req.Reason,
			)
			return &TokenResult{
				InputTokens:  stats.InputTokens,
				OutputTokens: stats.OutputTokens,
				IsFinal:      true,
				Source:       "openrouter_api",
			}, nil
		}
		if err != nil {
			f.logger.Warn("OpenRouter generation stats query failed, falling back to estimator",
				"turn_id", req.TurnID,
				"generation_id", req.GenerationID,
				"error", err,
			)
		}
	}

	// Strategy 3: Use token estimator if we have a cancel snapshot
	if f.estimator != nil && req.CancelSnapshot != "" {
		outputTokens, err := f.estimator.EstimateOutputTokens(ctx, req.Model, req.CancelSnapshot)
		if err == nil && outputTokens > 0 {
			f.logger.Info("using estimated tokens",
				"turn_id", req.TurnID,
				"output_tokens", outputTokens,
				"model", req.Model,
				"snapshot_length", len(req.CancelSnapshot),
				"reason", req.Reason,
			)
			return &TokenResult{
				InputTokens:  0, // Estimation only covers output tokens
				OutputTokens: outputTokens,
				IsFinal:      false,
				Source:       "estimator",
			}, nil
		}
		if err != nil {
			f.logger.Warn("token estimation failed",
				"turn_id", req.TurnID,
				"model", req.Model,
				"error", err,
			)
		}
	}

	// Strategy 4: Fallback - no tokens available
	f.logger.Debug("no token data available",
		"turn_id", req.TurnID,
		"model", req.Model,
		"reason", req.Reason,
		"has_generation_id", req.GenerationID != "",
		"has_snapshot", req.CancelSnapshot != "",
	)
	return &TokenResult{
		InputTokens:  0,
		OutputTokens: 0,
		IsFinal:      false,
		Source:       "none",
	}, nil
}

// openRouterGenerationStats represents the response from OpenRouter's generation stats endpoint.
type openRouterGenerationStats struct {
	InputTokens  int `json:"native_tokens_prompt"`
	OutputTokens int `json:"native_tokens_completion"`
}

// queryOpenRouterGenerationStats queries OpenRouter's generation stats API for native token counts.
func (f *DefaultTokenFinalizer) queryOpenRouterGenerationStats(ctx context.Context, generationID string) (*openRouterGenerationStats, error) {
	if f.openRouterAPIKey == "" {
		return nil, fmt.Errorf("OpenRouter API key not configured")
	}
	if generationID == "" {
		return nil, fmt.Errorf("generation ID not available")
	}

	url := fmt.Sprintf("https://openrouter.ai/api/v1/generation?id=%s", generationID)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+f.openRouterAPIKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := f.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to query generation stats: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("generation stats error (HTTP %d): %s", resp.StatusCode, string(body))
	}

	var stats openRouterGenerationStats
	if err := json.Unmarshal(body, &stats); err != nil {
		return nil, fmt.Errorf("failed to parse generation stats: %w", err)
	}

	return &stats, nil
}
