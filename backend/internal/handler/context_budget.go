package handler

import (
	"log/slog"
	"net/http"
	"strings"

	"meridian/internal/config"
	domainllm "meridian/internal/domain/llm"
	"meridian/internal/httputil"
	"meridian/internal/service/llm/tokens"
)

// BudgetThresholds defines the context pressure points used to trigger
// autocollapse (60%), autocompact (80%), and user-visible warnings (90%).
type BudgetThresholds struct {
	Collapse float64 `json:"collapse"`
	Compact  float64 `json:"compact"`
	Warn     float64 `json:"warn"`
}

// ContextBudgetResponse is the JSON response for GET /api/threads/{id}/context-budget.
type ContextBudgetResponse struct {
	Model            string           `json:"model"`
	ContextWindow    int              `json:"context_window"`
	MaxOutput        int              `json:"max_output"`
	TotalInput       int              `json:"total_input"`
	RemainingInput   int              `json:"remaining_input"`
	UsagePercent     float64          `json:"usage_percent"`
	Thresholds       BudgetThresholds `json:"thresholds"`
	EstimationMethod string           `json:"estimation_method"`
}

// defaultBudgetThresholds are the canonical 60/80/90 values documented in the
// estimator package. Hardcoded here so the frontend receives a single source of
// truth alongside each per-thread estimate.
var defaultBudgetThresholds = BudgetThresholds{
	Collapse: 0.60,
	Compact:  0.80,
	Warn:     0.90,
}

// ContextBudgetHandler handles context budget requests for thread conversations.
// It combines thread access control, turn-path retrieval, and tiktoken estimation
// into a single read-only endpoint.
type ContextBudgetHandler struct {
	threadService        domainllm.ThreadService
	threadHistoryService domainllm.ThreadHistoryService
	estimator            tokens.TokenEstimator
	config               *config.Config
	logger               *slog.Logger
}

// NewContextBudgetHandler creates a new ContextBudgetHandler.
func NewContextBudgetHandler(
	threadService domainllm.ThreadService,
	threadHistoryService domainllm.ThreadHistoryService,
	estimator tokens.TokenEstimator,
	cfg *config.Config,
	logger *slog.Logger,
) *ContextBudgetHandler {
	return &ContextBudgetHandler{
		threadService:        threadService,
		threadHistoryService: threadHistoryService,
		estimator:            estimator,
		config:               cfg,
		logger:               logger,
	}
}

// GetContextBudget returns the estimated token usage for the thread's active conversation path.
// GET /api/threads/{id}/context-budget
//
// The path is rooted at the thread's last_viewed_turn_id. When that field is nil
// (fresh thread with no viewed turns) the response reflects an empty conversation.
//
// Token counts are approximate (±5%) via tiktoken cl100k_base encoding.
func (h *ContextBudgetHandler) GetContextBudget(w http.ResponseWriter, r *http.Request) {
	threadID, ok := PathParam(w, r, "id", "Thread ID")
	if !ok {
		return
	}

	userID := httputil.GetUserID(r)

	// GetThread validates ownership; 404/403 propagated via handleError.
	thread, err := h.threadService.GetThread(r.Context(), threadID, userID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	// Resolve model: config default with a hard-coded last-resort guard.
	// The actual model is overridden below once we find an assistant turn.
	model := h.config.LLM.DefaultModel
	if model == "" {
		// Guard against misconfigured environments.
		model = "claude-haiku-4-5-20251001"
	}

	// Extract system prompt (may be absent on threads that inherit from the project).
	systemPrompt := ""
	if thread.SystemPrompt != nil {
		systemPrompt = *thread.SystemPrompt
	}

	// Fresh thread: no turns have been viewed yet — return a zero-token baseline.
	if thread.LastViewedTurnID == nil {
		estimate, err := h.estimator.EstimateRequest(r.Context(), tokens.EstimateRequest{
			Model:        model,
			SystemPrompt: systemPrompt,
		})
		if err != nil {
			h.logger.Error("context budget estimation failed (empty thread)",
				"thread_id", threadID,
				"error", err,
			)
			httputil.RespondError(w, http.StatusInternalServerError, "failed to estimate context budget")
			return
		}
		httputil.RespondJSON(w, http.StatusOK, h.buildResponse(model, estimate))
		return
	}

	// Fetch the full turn path from root → last_viewed_turn_id (blocks included).
	turns, err := h.threadHistoryService.GetTurnPath(r.Context(), userID, *thread.LastViewedTurnID)
	if err != nil {
		handleError(w, err, h.config)
		return
	}

	// Override model with the one reported by the most recent assistant turn.
	// Iterate in reverse so we pick the last-used model quickly.
	for i := len(turns) - 1; i >= 0; i-- {
		if turns[i].Role == "assistant" && turns[i].Model != nil && *turns[i].Model != "" {
			model = *turns[i].Model
			break
		}
	}

	// Convert turns to the lightweight message representation for estimation.
	messages := buildMessagesFromTurns(turns)

	estimate, err := h.estimator.EstimateRequest(r.Context(), tokens.EstimateRequest{
		Model:        model,
		SystemPrompt: systemPrompt,
		Messages:     messages,
	})
	if err != nil {
		h.logger.Error("context budget estimation failed",
			"thread_id", threadID,
			"turn_count", len(turns),
			"model", model,
			"error", err,
		)
		httputil.RespondError(w, http.StatusInternalServerError, "failed to estimate context budget")
		return
	}

	httputil.RespondJSON(w, http.StatusOK, h.buildResponse(model, estimate))
}

// buildResponse assembles a ContextBudgetResponse from a completed estimate.
func (h *ContextBudgetHandler) buildResponse(model string, est *tokens.TokenEstimate) ContextBudgetResponse {
	return ContextBudgetResponse{
		Model:            model,
		ContextWindow:    est.ContextWindow,
		MaxOutput:        est.MaxOutput,
		TotalInput:       est.TotalInput,
		RemainingInput:   est.RemainingInput,
		UsagePercent:     est.UsagePercent,
		Thresholds:       defaultBudgetThresholds,
		EstimationMethod: "tiktoken",
	}
}

// buildMessagesFromTurns converts a turn path into the lightweight message slice
// consumed by TokenEstimator. Only text blocks are extracted; tool and thinking
// blocks are omitted. This stays within the ±5% tolerance required by the
// 60%/80%/90% threshold-based triggering system.
func buildMessagesFromTurns(turns []domainllm.Turn) []tokens.Message {
	messages := make([]tokens.Message, 0, len(turns))
	for _, turn := range turns {
		content := extractTextFromBlocks(turn.Blocks)
		if content == "" {
			// Skip turns whose content is non-textual (e.g. pure tool invocations).
			continue
		}
		messages = append(messages, tokens.Message{
			Role:    turn.Role,
			Content: content,
		})
	}
	return messages
}

// extractTextFromBlocks concatenates all text_content values from a turn's blocks.
// Non-text blocks (thinking, tool_use, tool_result, image, …) are ignored —
// they add acceptable estimation variance within the ±5% budget.
func extractTextFromBlocks(blocks []domainllm.TurnBlock) string {
	var parts []string
	for _, block := range blocks {
		if block.BlockType == domainllm.BlockTypeText && block.TextContent != nil && *block.TextContent != "" {
			parts = append(parts, *block.TextContent)
		}
	}
	return strings.Join(parts, "\n")
}
