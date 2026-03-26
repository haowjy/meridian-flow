package streaming

// compaction_service.go — LLM-based context compaction for long-running conversations.
//
// CompactionService summarises the conversation turns since the last compaction bookmark
// using a fast/cheap model (haiku-class), then persists the result as a new compaction
// turn in the conversation tree.  The next call to MessageBuilder.BuildMessages will
// detect the compaction turn, skip all prior turns, and inject the summary instead.
//
// Placement in the turn tree:
//   The compaction turn is stored as a child of the current (most-recent) turn in the
//   path.  The caller (e.g. TokenMonitor / CM2) is responsible for surfacing the
//   compaction turn ID so that subsequent user messages use it as their prev_turn_id,
//   ensuring the summary appears in every future path that flows through it.

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	domainllm "meridian/internal/domain/llm"
)

const (
	// compactionModel is the fast/cheap model used for summarisation.
	// Can be overridden via constructor option for testing or environment-specific routing.
	defaultCompactionModel = "claude-haiku-4-5-20251001"

	// compactionSystemPrompt instructs the model to produce a dense, faithful summary.
	compactionSystemPrompt = `You are a conversation summarizer. Your task is to produce a concise but complete summary of the conversation provided, capturing:
1. Key information exchanged and user requests
2. Decisions made, conclusions reached, and actions taken
3. Important context needed to continue the conversation seamlessly
4. The current state of any ongoing tasks or goals

Output only the summary text — no preamble, no headings, no markdown formatting.`

	// compactionMaxTokens caps the summary length to avoid oversized context injections.
	compactionMaxTokens = 1024
)

// CompactionService summarises conversation history via an LLM and persists the
// result as a compaction bookmark turn.
//
// Thread-safety: safe for concurrent use; all state is immutable after construction.
type CompactionService struct {
	turnReader    domainllm.TurnReader
	turnWriter    domainllm.TurnWriter
	turnNavigator domainllm.TurnNavigator
	provider      domainllm.LLMProvider
	model         string
	logger        *slog.Logger
}

// NewCompactionService creates a CompactionService with the given dependencies.
//
// provider must support the fast summarisation model; callers should pass a haiku-class
// provider.  model overrides the default (defaultCompactionModel) when non-empty.
func NewCompactionService(
	turnReader domainllm.TurnReader,
	turnWriter domainllm.TurnWriter,
	turnNavigator domainllm.TurnNavigator,
	provider domainllm.LLMProvider,
	model string,
	logger *slog.Logger,
) *CompactionService {
	if model == "" {
		model = defaultCompactionModel
	}
	return &CompactionService{
		turnReader:    turnReader,
		turnWriter:    turnWriter,
		turnNavigator: turnNavigator,
		provider:      provider,
		model:         model,
		logger:        logger,
	}
}

// CompactResult carries the outcome of a Compact call.
type CompactResult struct {
	// CompactionTurnID is the ID of the newly created compaction turn.
	// Callers should surface this so subsequent user messages use it as prev_turn_id.
	CompactionTurnID string

	// Summary is the LLM-generated summary that was stored in the compaction turn.
	Summary string
}

// Compact summarises the conversation rooted at currentTurnID and creates a compaction
// bookmark turn as a child of that turn.
//
// Steps:
//  1. Load the full turn path from root to currentTurnID.
//  2. Find the most recent existing compaction turn (if any) — only turns after it
//     are included in the summarisation prompt (avoids double-summarising).
//  3. Build a plain-text transcript of the relevant turns.
//  4. Call the fast model with a summarisation prompt.
//  5. Persist a system turn (role="system", turn_type="compaction") with the summary
//     as a text block, linked to currentTurnID via prev_turn_id.
//
// Returns ErrNotFound (wrapped) if currentTurnID does not exist.
func (s *CompactionService) Compact(ctx context.Context, currentTurnID string) (*CompactResult, error) {
	// 1. Load the full path.
	path, err := s.turnNavigator.GetTurnPath(ctx, currentTurnID)
	if err != nil {
		return nil, fmt.Errorf("compaction: get turn path: %w", err)
	}
	if len(path) == 0 {
		return nil, fmt.Errorf("compaction: empty turn path for turn %s", currentTurnID)
	}

	// Identify the thread from the path (all turns share the same thread).
	threadID := path[0].ThreadID

	// 2. Load blocks for all turns in a single batch.
	turnIDs := make([]string, len(path))
	for i, t := range path {
		turnIDs[i] = t.ID
	}
	blocksByTurn, err := s.turnReader.GetTurnBlocksForTurns(ctx, turnIDs)
	if err != nil {
		return nil, fmt.Errorf("compaction: load blocks: %w", err)
	}
	for i := range path {
		if blocks, ok := blocksByTurn[path[i].ID]; ok {
			path[i].Blocks = blocks
		}
	}

	// 3. Determine the slice to summarise.
	// If a prior compaction turn exists, summarise only turns after it (the new delta).
	startIdx := 0
	prevCompactionIdx := domainllm.FindLastCompactionTurn(path)
	if prevCompactionIdx >= 0 {
		startIdx = prevCompactionIdx + 1
	}

	turnsToSummarise := path[startIdx:]
	if len(turnsToSummarise) == 0 {
		s.logger.Info("compaction: no new turns since last compaction; skipping",
			"current_turn_id", currentTurnID,
			"prev_compaction_idx", prevCompactionIdx,
		)
		return nil, nil
	}

	// 4. Build the transcript text.
	transcript := buildTranscript(turnsToSummarise)

	// 5. Summarise via the fast model.
	summary, err := s.summarise(ctx, transcript)
	if err != nil {
		return nil, fmt.Errorf("compaction: summarise: %w", err)
	}

	// 6. Persist the compaction turn.
	compactionTurnID, err := s.persistCompactionTurn(ctx, threadID, currentTurnID, summary)
	if err != nil {
		return nil, fmt.Errorf("compaction: persist turn: %w", err)
	}

	s.logger.Info("compaction: created compaction turn",
		"thread_id", threadID,
		"current_turn_id", currentTurnID,
		"compaction_turn_id", compactionTurnID,
		"summary_len", len(summary),
		"turns_summarised", len(turnsToSummarise),
	)

	return &CompactResult{
		CompactionTurnID: compactionTurnID,
		Summary:          summary,
	}, nil
}

// summarise sends the transcript to the fast model and returns the summary text.
func (s *CompactionService) summarise(ctx context.Context, transcript string) (string, error) {
	maxTokens := compactionMaxTokens
	systemPrompt := compactionSystemPrompt

	req := &domainllm.GenerateRequest{
		Model: s.model,
		Messages: []domainllm.Message{
			{
				Role: domainllm.TurnRoleUser,
				Content: []*domainllm.TurnBlock{
					{
						BlockType:   domainllm.BlockTypeText,
						TextContent: &transcript,
					},
				},
			},
		},
		Params: &domainllm.RequestParams{
			Model:     &s.model,
			MaxTokens: &maxTokens,
			System:    &systemPrompt,
		},
	}

	resp, err := s.provider.GenerateResponse(ctx, req)
	if err != nil {
		return "", fmt.Errorf("provider error: %w", err)
	}

	// Extract text from the first text block in the response.
	for _, block := range resp.Content {
		if block.BlockType == domainllm.BlockTypeText && block.TextContent != nil && *block.TextContent != "" {
			return *block.TextContent, nil
		}
	}

	return "", fmt.Errorf("provider returned no text content in response")
}

// persistCompactionTurn creates a system turn containing the compaction summary.
func (s *CompactionService) persistCompactionTurn(
	ctx context.Context,
	threadID string,
	prevTurnID string,
	summary string,
) (string, error) {
	now := time.Now().UTC()

	turn := &domainllm.Turn{
		ID:       uuid.New().String(),
		ThreadID: threadID,
		PrevTurnID: func() *string {
			s := prevTurnID
			return &s
		}(),
		Role:   domainllm.TurnRoleSystem,
		Status: domainllm.TurnStatusComplete,
		RequestParams: map[string]interface{}{
			"turn_type": domainllm.TurnTypeCompaction,
		},
		CreatedAt:   now,
		CompletedAt: &now,
	}

	if err := s.turnWriter.CreateTurn(ctx, turn); err != nil {
		return "", fmt.Errorf("create compaction turn: %w", err)
	}

	// Store the summary as a text block on the compaction turn.
	block := &domainllm.TurnBlock{
		TurnID:      turn.ID,
		BlockType:   domainllm.BlockTypeText,
		Sequence:    0,
		TextContent: &summary,
		CreatedAt:   now,
	}
	if err := s.turnWriter.CreateTurnBlock(ctx, block); err != nil {
		return "", fmt.Errorf("create compaction block: %w", err)
	}

	return turn.ID, nil
}

// buildTranscript converts a slice of turns into a human-readable plain-text
// transcript suitable for summarisation.  Only user and assistant turns are
// included; system (bookmark) turns are skipped.
//
// Format per turn:
//
//	User: <text content>
//	[tool: <tool_name>]   (for tool_use blocks)
//	[result: <collapsed or truncated>]   (for tool_result blocks)
func buildTranscript(turns []domainllm.Turn) string {
	var sb strings.Builder

	for _, turn := range turns {
		// Skip bookmark turns — they carry no conversation content.
		if turn.IsBookmarkTurn() {
			continue
		}

		var label string
		switch turn.Role {
		case domainllm.TurnRoleUser:
			label = "User"
		case domainllm.TurnRoleAssistant:
			label = "Assistant"
		default:
			continue
		}

		// Collect text segments from this turn's blocks.
		var segments []string
		for _, block := range turn.Blocks {
			switch block.BlockType {
			case domainllm.BlockTypeText, domainllm.BlockTypeThinking:
				if block.TextContent != nil && *block.TextContent != "" {
					segments = append(segments, *block.TextContent)
				}
			case domainllm.BlockTypeToolUse:
				toolName, _ := block.Content["tool_name"].(string)
				if toolName != "" {
					segments = append(segments, fmt.Sprintf("[used tool: %s]", toolName))
				}
			case domainllm.BlockTypeToolResult:
				// Prefer collapsed_content for brevity; fall back to a placeholder.
				if block.CollapsedContent != nil && *block.CollapsedContent != "" {
					segments = append(segments, fmt.Sprintf("[tool result: %s]", *block.CollapsedContent))
				} else {
					// Inline result text if short enough; otherwise a placeholder.
					result, _ := block.Content["result"].(string)
					if len(result) <= 200 {
						segments = append(segments, fmt.Sprintf("[tool result: %s]", result))
					} else {
						segments = append(segments, "[tool result: <large output omitted>]")
					}
				}
			}
		}

		if len(segments) == 0 {
			continue
		}

		sb.WriteString(label)
		sb.WriteString(": ")
		sb.WriteString(strings.Join(segments, " "))
		sb.WriteString("\n")
	}

	return strings.TrimSpace(sb.String())
}
