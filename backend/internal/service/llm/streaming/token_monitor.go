package streaming

// token_monitor.go — TokenMonitor checks context window budget after turn completion
// and signals when autocollapse/autocompact thresholds are crossed.
//
// Thresholds applied to UsagePercent = TotalInput / (ContextWindow - MaxOutput):
//   60% → ShouldCollapse: persist a collapse_marker system turn for CM3 MessageBuilder
//   80% → ShouldCompact:  reserved for future aggressive context compaction
//   90% → ShouldWarn:     emit context_warning SSE event to the frontend
//
// The monitor must NOT block turn completion — CheckBudget is synchronous but fast
// (tiktoken encoding is in-memory, ~1 ms). Collapse-marker DB writes run in a goroutine.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	mstream "github.com/haowjy/meridian-stream-go"

	"meridian/internal/capabilities"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/service/llm/tokens"
)

// Budget threshold constants. Canonical values match handler/context_budget.go.
const (
	budgetCollapseThreshold = 0.60 // 60%: create collapse_marker turn
	budgetCompactThreshold  = 0.80 // 80%: compact signal (reserved for future use)
	budgetWarnThreshold     = 0.90 // 90%: emit context_warning SSE event
)

// BudgetCheck holds the result of a single context budget evaluation.
//
// Flags are additive: ShouldWarn implies ShouldCompact, which implies ShouldCollapse.
// Callers that only care about one level can check the appropriate flag alone.
type BudgetCheck struct {
	// ShouldCollapse is true when UsagePercent >= 60%.
	// A collapse_marker turn should be persisted so CM3 can truncate old history.
	ShouldCollapse bool

	// ShouldCompact is true when UsagePercent >= 80%.
	// Reserved for future aggressive context compaction (no-op in CM2).
	ShouldCompact bool

	// ShouldWarn is true when UsagePercent >= 90%.
	// A context_warning SSE event should be emitted to the frontend.
	ShouldWarn bool

	// UsagePercent is the estimated context fraction (0.0–1.0+).
	// Values > 1.0 indicate the request exceeds the available context budget.
	UsagePercent float64
}

// TokenMonitor evaluates context window usage after turn completion and signals
// threshold crossings. Safe for concurrent use (TokenEstimator is concurrency-safe).
type TokenMonitor struct {
	estimator   tokens.TokenEstimator
	capRegistry *capabilities.Registry // retained for forward-compat; currently unused directly
	logger      *slog.Logger
}

// NewTokenMonitor creates a TokenMonitor backed by the given estimator.
// capRegistry is stored for forward-compatibility with future direct capability queries.
func NewTokenMonitor(
	estimator tokens.TokenEstimator,
	capRegistry *capabilities.Registry,
	logger *slog.Logger,
) *TokenMonitor {
	return &TokenMonitor{
		estimator:   estimator,
		capRegistry: capRegistry,
		logger:      logger,
	}
}

// CheckBudget estimates context usage for req and returns threshold flags.
//
// Returns an empty BudgetCheck (all false) when the model is not found in the
// CapabilityRegistry (ContextWindow == 0), preventing false positives for unknown models.
//
// Estimation accuracy is ±5% (tiktoken cl100k_base), which is acceptable for the
// conservative 60/80/90 pct thresholds.
func (m *TokenMonitor) CheckBudget(ctx context.Context, req tokens.EstimateRequest) (BudgetCheck, error) {
	est, err := m.estimator.EstimateRequest(ctx, req)
	if err != nil {
		return BudgetCheck{}, fmt.Errorf("token estimation failed: %w", err)
	}

	// Cannot apply thresholds without a known context window.
	if est.ContextWindow == 0 {
		m.logger.Debug("skipping budget check: unknown context window",
			"model", req.Model,
		)
		return BudgetCheck{}, nil
	}

	pct := est.UsagePercent
	check := BudgetCheck{
		ShouldCollapse: pct >= budgetCollapseThreshold,
		ShouldCompact:  pct >= budgetCompactThreshold,
		ShouldWarn:     pct >= budgetWarnThreshold,
		UsagePercent:   pct,
	}

	m.logger.Debug("budget check complete",
		"model", req.Model,
		"usage_pct", pct,
		"context_window", est.ContextWindow,
		"total_input", est.TotalInput,
		"should_collapse", check.ShouldCollapse,
		"should_compact", check.ShouldCompact,
		"should_warn", check.ShouldWarn,
	)

	return check, nil
}

// =============================================================================
// StreamExecutor integration methods
// =============================================================================

// SetTokenMonitor wires a TokenMonitor into the executor.
// Must be called before Start(); safe to leave nil (monitoring disabled).
func (se *StreamExecutor) SetTokenMonitor(monitor *TokenMonitor) {
	se.tokenMonitor = monitor
}

// buildEstimateRequest converts the stored GenerateRequest into a tokens.EstimateRequest
// suitable for token estimation.
//
// Only text-type blocks are extracted from messages; tool/thinking blocks are omitted.
// This stays within the ±5% estimation tolerance. Tool definitions contribute
// name + description + schema; built-in-only tools (no Function) contribute name only.
//
// Note: se.req contains the messages sent to the LLM at request time (initial or
// continuation). For multi-tool-round turns this may undercount tool result tokens,
// but the conservative 60% threshold absorbs the approximation error.
func (se *StreamExecutor) buildEstimateRequest() tokens.EstimateRequest {
	req := tokens.EstimateRequest{
		Model: se.model,
	}

	if se.req == nil {
		return req
	}

	// System prompt
	if se.req.Params != nil && se.req.Params.System != nil {
		req.SystemPrompt = *se.req.Params.System
	}

	// Messages: extract text content from each message's blocks.
	for _, msg := range se.req.Messages {
		content := extractTextFromDomainMessage(msg)
		if content == "" {
			// Skip non-textual messages (pure tool invocations, etc.)
			continue
		}
		req.Messages = append(req.Messages, tokens.Message{
			Role:    msg.Role,
			Content: content,
		})
	}

	// Tools: convert ToolDefinitions to tokens.Tool for schema-aware estimation.
	if se.req.Params != nil {
		for _, toolDef := range se.req.Params.Tools {
			if toolDef.Function != nil {
				schemaJSON := marshalToolParameters(toolDef.Function.Parameters)
				req.Tools = append(req.Tools, tokens.Tool{
					Name:        toolDef.Function.Name,
					Description: toolDef.Function.Description,
					InputSchema: schemaJSON,
				})
			} else if toolDef.Name != "" {
				// Minimal built-in tool (no schema available)
				req.Tools = append(req.Tools, tokens.Tool{
					Name: toolDef.Name,
				})
			}
		}
	}

	return req
}

// extractTextFromDomainMessage concatenates text_content from all text-type blocks
// in a domain message. Non-text blocks (thinking, tool_use, tool_result, image) are
// ignored — their contribution is within the ±5% estimation tolerance.
func extractTextFromDomainMessage(msg domainllm.Message) string {
	var parts []string
	for _, block := range msg.Content {
		if block == nil {
			continue
		}
		if block.BlockType == domainllm.BlockTypeText && block.TextContent != nil && *block.TextContent != "" {
			parts = append(parts, *block.TextContent)
		}
	}
	return strings.Join(parts, "\n")
}

// marshalToolParameters marshals a tool parameter schema to a JSON string for
// token estimation. Returns "" on marshal failure (acceptable; the estimator
// will simply not count schema tokens for this tool).
func marshalToolParameters(params interface{}) string {
	if params == nil {
		return ""
	}
	b, err := json.Marshal(params)
	if err != nil {
		return ""
	}
	return string(b)
}

// checkBudgetAndAct estimates context usage, emits a context_warning SSE event
// if ShouldWarn is set, and returns the BudgetCheck for the caller to act on.
//
// This is synchronous but fast (tiktoken encoding is ~1 ms in-memory).
// DB side-effects (collapse marker creation) must be handled by the caller asynchronously.
//
// Returns an empty BudgetCheck if the monitor is not configured or se.req is nil.
func (se *StreamExecutor) checkBudgetAndAct(ctx context.Context, send func(mstream.Event)) BudgetCheck {
	if se.tokenMonitor == nil || se.req == nil {
		return BudgetCheck{}
	}

	estimateReq := se.buildEstimateRequest()
	budget, err := se.tokenMonitor.CheckBudget(ctx, estimateReq)
	if err != nil {
		// Non-fatal: log and continue without triggering any actions.
		se.logger.Warn("token budget check failed; skipping context management actions",
			"turn_id", se.turnID,
			"error", err,
		)
		return BudgetCheck{}
	}

	// Emit context_warning SSE event when warn threshold (90%) is crossed.
	// Emitted before RUN_FINISHED so frontends can display it during the stream.
	if budget.ShouldWarn {
		warningPayload, _ := json.Marshal(map[string]interface{}{
			"type":          "context_warning",
			"usage_percent": budget.UsagePercent,
		})
		send(mstream.NewEvent(warningPayload).WithType("context_warning"))

		se.logger.Info("context warning emitted",
			"turn_id", se.turnID,
			"usage_percent", budget.UsagePercent,
		)
	} else if budget.ShouldCollapse {
		se.logger.Info("context collapse threshold crossed",
			"turn_id", se.turnID,
			"usage_percent", budget.UsagePercent,
		)
	}

	return budget
}

// createCollapseMarkerAsync persists a system turn containing a collapse_marker block.
// The turn is linked after the current assistant turn so CM3's MessageBuilder can
// detect it when building conversation history for future requests.
//
// Runs asynchronously to avoid blocking turn completion. Failures are logged but
// not propagated — the stream has already completed successfully.
func (se *StreamExecutor) createCollapseMarkerAsync(usagePercent float64) {
	// Capture all values before entering the goroutine to avoid races.
	threadID := se.threadID
	assistantTurnID := se.turnID
	turnWriter := se.turnWriter
	logger := se.logger

	go func() {
		// Use background context + deadline — the original stream context may be
		// cancelled by the time the goroutine runs.
		bgCtx, cancel := context.WithTimeout(context.Background(), dbWriteDeadline)
		defer cancel()

		now := time.Now().UTC()

		// Create the system turn that marks the collapse boundary.
		markerTurn := &domainllm.Turn{
			ThreadID:   threadID,
			PrevTurnID: &assistantTurnID,
			Role:       "system",
			Status:     domainllm.TurnStatusComplete,
			CreatedAt:  now,
		}

		if err := turnWriter.CreateTurn(bgCtx, markerTurn); err != nil {
			logger.Warn("failed to create collapse marker turn",
				"assistant_turn_id", assistantTurnID,
				"error", err,
			)
			return
		}

		// Add a collapse_marker block carrying usage metadata for CM3.
		markerBlock := &domainllm.TurnBlock{
			TurnID:    markerTurn.ID,
			BlockType: domainllm.BlockTypeCollapseMarker,
			Sequence:  0,
			Content: map[string]interface{}{
				"usage_percent": usagePercent,
			},
			CreatedAt: now,
		}

		if err := turnWriter.CreateTurnBlock(bgCtx, markerBlock); err != nil {
			logger.Warn("failed to create collapse marker block",
				"assistant_turn_id", assistantTurnID,
				"marker_turn_id", markerTurn.ID,
				"error", err,
			)
			return
		}

		logger.Info("collapse marker turn created",
			"assistant_turn_id", assistantTurnID,
			"marker_turn_id", markerTurn.ID,
			"usage_percent", usagePercent,
		)
	}()
}
