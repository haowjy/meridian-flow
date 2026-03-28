package streaming

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	domainllm "meridian/internal/domain/llm"
)

// =============================================================================
// Stubs
// =============================================================================

// stubTurnNavigator stubs TurnNavigator; only GetTurnPath is used by CompactionService.
type stubTurnNavigator struct {
	path []domainllm.Turn
	err  error
}

func (s *stubTurnNavigator) GetTurnPath(_ context.Context, _ string) ([]domainllm.Turn, error) {
	return s.path, s.err
}
func (s *stubTurnNavigator) GetTurnSiblings(_ context.Context, _ string) ([]domainllm.Turn, error) {
	panic("stubTurnNavigator.GetTurnSiblings not expected")
}
func (s *stubTurnNavigator) GetSiblingsForTurns(_ context.Context, _ []string) (map[string][]string, error) {
	panic("stubTurnNavigator.GetSiblingsForTurns not expected")
}
func (s *stubTurnNavigator) GetPaginatedTurns(_ context.Context, _, _ string, _ *string, _ int, _ string, _ bool) (*domainllm.PaginatedTurnsResponse, error) {
	panic("stubTurnNavigator.GetPaginatedTurns not expected")
}

// stubTurnReader stubs TurnReader; only GetTurnBlocksForTurns is used by CompactionService.
type stubTurnReader struct {
	blocksByTurn map[string][]domainllm.TurnBlock
	err          error
}

func (s *stubTurnReader) GetTurn(_ context.Context, _ string) (*domainllm.Turn, error) {
	panic("stubTurnReader.GetTurn not expected")
}
func (s *stubTurnReader) GetRootTurns(_ context.Context, _ string) ([]domainllm.Turn, error) {
	panic("stubTurnReader.GetRootTurns not expected")
}
func (s *stubTurnReader) GetTurnBlocks(_ context.Context, _ string) ([]domainllm.TurnBlock, error) {
	panic("stubTurnReader.GetTurnBlocks not expected")
}
func (s *stubTurnReader) GetTurnBlocksForTurns(_ context.Context, _ []string) (map[string][]domainllm.TurnBlock, error) {
	return s.blocksByTurn, s.err
}
func (s *stubTurnReader) GetLastBlockSequence(_ context.Context, _ string) (int, error) {
	panic("stubTurnReader.GetLastBlockSequence not expected")
}

// recordingTurnWriter records calls to CreateTurn and CreateTurnBlock for assertion.
type recordingTurnWriter struct {
	createdTurns   []*domainllm.Turn
	createdBlocks  []*domainllm.TurnBlock
	createTurnErr  error
	createBlockErr error
}

func (w *recordingTurnWriter) CreateTurn(_ context.Context, turn *domainllm.Turn) error {
	if w.createTurnErr != nil {
		return w.createTurnErr
	}
	w.createdTurns = append(w.createdTurns, turn)
	return nil
}
func (w *recordingTurnWriter) CreateTurnBlock(_ context.Context, block *domainllm.TurnBlock) error {
	if w.createBlockErr != nil {
		return w.createBlockErr
	}
	w.createdBlocks = append(w.createdBlocks, block)
	return nil
}
func (w *recordingTurnWriter) CreateTurnBlocks(_ context.Context, _ []domainllm.TurnBlock) error {
	panic("recordingTurnWriter.CreateTurnBlocks not expected")
}
func (w *recordingTurnWriter) UpdateTurnStatus(_ context.Context, _ string, _ domainllm.TurnStatus, _ *domainllm.Turn) error {
	panic("recordingTurnWriter.UpdateTurnStatus not expected")
}
func (w *recordingTurnWriter) UpdateTurn(_ context.Context, _ *domainllm.Turn) error {
	panic("recordingTurnWriter.UpdateTurn not expected")
}
func (w *recordingTurnWriter) UpdateTurnError(_ context.Context, _, _ string) error {
	panic("recordingTurnWriter.UpdateTurnError not expected")
}
func (w *recordingTurnWriter) UpdateTurnMetadata(_ context.Context, _ string, _ map[string]interface{}) error {
	panic("recordingTurnWriter.UpdateTurnMetadata not expected")
}
func (w *recordingTurnWriter) AccumulateTokensAndUpdateMetadata(_ context.Context, _ string, _ *domainllm.TurnTokenUpdate, _ *domainllm.TurnCompletionUpdate) error {
	panic("recordingTurnWriter.AccumulateTokensAndUpdateMetadata not expected")
}
func (w *recordingTurnWriter) UpsertPartialBlock(_ context.Context, _ *domainllm.TurnBlock) error {
	panic("recordingTurnWriter.UpsertPartialBlock not expected")
}
func (w *recordingTurnWriter) AppendGenerationRecord(_ context.Context, _ string, _ *domainllm.GenerationRecord) error {
	panic("recordingTurnWriter.AppendGenerationRecord not expected")
}

// stubLLMProvider stubs LLMProvider; only GenerateResponse is used.
type stubLLMProvider struct {
	summary string
	err     error
}

func (s *stubLLMProvider) GenerateResponse(_ context.Context, _ *domainllm.GenerateRequest) (*domainllm.GenerateResponse, error) {
	if s.err != nil {
		return nil, s.err
	}
	content := s.summary
	return &domainllm.GenerateResponse{
		Content: []*domainllm.TurnBlock{
			{
				BlockType:   domainllm.BlockTypeText,
				TextContent: &content,
			},
		},
	}, nil
}
func (s *stubLLMProvider) StreamResponse(_ context.Context, _ *domainllm.GenerateRequest) (<-chan domainllm.StreamEvent, error) {
	panic("stubLLMProvider.StreamResponse not expected")
}
func (s *stubLLMProvider) Name() string                { return "stub" }
func (s *stubLLMProvider) SupportsModel(_ string) bool { return true }

// =============================================================================
// Helpers
// =============================================================================

func newLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func cptr(s string) *string { return &s }

func makeTurn(id, threadID, role string, prevTurnID *string, requestParams map[string]interface{}) domainllm.Turn {
	return domainllm.Turn{
		ID:            id,
		ThreadID:      threadID,
		PrevTurnID:    prevTurnID,
		Role:          role,
		Status:        domainllm.TurnStatusComplete,
		RequestParams: requestParams,
		CreatedAt:     time.Now(),
	}
}

func textBlock(turnID, text string) domainllm.TurnBlock {
	return domainllm.TurnBlock{
		TurnID:      turnID,
		BlockType:   domainllm.BlockTypeText,
		Sequence:    0,
		TextContent: cptr(text),
	}
}

// =============================================================================
// Tests — CompactionService.Compact
// =============================================================================

// TestCompact_BasicFlow verifies that Compact summarises all turns when there is no
// prior compaction bookmark and persists a compaction turn with the LLM summary.
func TestCompact_BasicFlow(t *testing.T) {
	const (
		threadID    = "thread-1"
		turn1ID     = "turn-user-1"
		turn2ID     = "turn-asst-1"
		currentID   = turn2ID
		wantSummary = "User asked about Go; assistant explained goroutines."
	)

	path := []domainllm.Turn{
		makeTurn(turn1ID, threadID, domainllm.TurnRoleUser, nil, nil),
		makeTurn(turn2ID, threadID, domainllm.TurnRoleAssistant, cptr(turn1ID), nil),
	}

	blocksByTurn := map[string][]domainllm.TurnBlock{
		turn1ID: {textBlock(turn1ID, "Tell me about goroutines.")},
		turn2ID: {textBlock(turn2ID, "Goroutines are lightweight threads managed by the Go runtime.")},
	}

	nav := &stubTurnNavigator{path: path}
	rdr := &stubTurnReader{blocksByTurn: blocksByTurn}
	wtr := &recordingTurnWriter{}
	prov := &stubLLMProvider{summary: wantSummary}

	svc := NewCompactionService(rdr, wtr, nav, prov, "", newLogger())

	result, err := svc.Compact(context.Background(), currentID)
	if err != nil {
		t.Fatalf("Compact failed: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}

	// Verify summary matches provider output.
	if result.Summary != wantSummary {
		t.Errorf("summary mismatch: got %q want %q", result.Summary, wantSummary)
	}

	// Verify a compaction turn was created.
	if len(wtr.createdTurns) != 1 {
		t.Fatalf("expected 1 turn created, got %d", len(wtr.createdTurns))
	}
	ct := wtr.createdTurns[0]
	if ct.Role != domainllm.TurnRoleSystem {
		t.Errorf("compaction turn role: got %q want %q", ct.Role, domainllm.TurnRoleSystem)
	}
	if ct.IsCompactionTurn() == false {
		t.Error("IsCompactionTurn() should be true for the created turn")
	}
	if ct.PrevTurnID == nil || *ct.PrevTurnID != currentID {
		t.Errorf("compaction turn prev_turn_id: got %v want %q", ct.PrevTurnID, currentID)
	}
	if ct.Status != domainllm.TurnStatusComplete {
		t.Errorf("compaction turn status: got %q want complete", ct.Status)
	}

	// Verify result ID matches the created turn.
	if result.CompactionTurnID != ct.ID {
		t.Errorf("result.CompactionTurnID %q != created turn ID %q", result.CompactionTurnID, ct.ID)
	}

	// Verify a text block was created for the summary.
	if len(wtr.createdBlocks) != 1 {
		t.Fatalf("expected 1 block created, got %d", len(wtr.createdBlocks))
	}
	blk := wtr.createdBlocks[0]
	if blk.BlockType != domainllm.BlockTypeText {
		t.Errorf("block type: got %q want text", blk.BlockType)
	}
	if blk.TextContent == nil || *blk.TextContent != wantSummary {
		t.Errorf("block text: got %v want %q", blk.TextContent, wantSummary)
	}
}

// TestCompact_SincePriorCompaction verifies that Compact only summarises turns after
// the most recent compaction turn (delta compaction), not the entire history.
func TestCompact_SincePriorCompaction(t *testing.T) {
	const (
		threadID     = "thread-1"
		turn1ID      = "turn-user-1"
		turn2ID      = "turn-asst-1"
		compactionID = "compaction-1"
		turn3ID      = "turn-user-2"
		turn4ID      = "turn-asst-2"
		currentID    = turn4ID
		wantSummary  = "Delta: user asked follow-up about channels."
	)

	// Path includes a prior compaction turn at index 2.
	path := []domainllm.Turn{
		makeTurn(turn1ID, threadID, domainllm.TurnRoleUser, nil, nil),
		makeTurn(turn2ID, threadID, domainllm.TurnRoleAssistant, cptr(turn1ID), nil),
		makeTurn(compactionID, threadID, domainllm.TurnRoleSystem, cptr(turn2ID), map[string]interface{}{
			"turn_type": domainllm.TurnTypeCompaction,
		}),
		makeTurn(turn3ID, threadID, domainllm.TurnRoleUser, cptr(compactionID), nil),
		makeTurn(turn4ID, threadID, domainllm.TurnRoleAssistant, cptr(turn3ID), nil),
	}

	// Blocks for the compaction turn provide a prior summary.
	priorSummary := "Prior summary: goroutines explained."
	blocksByTurn := map[string][]domainllm.TurnBlock{
		turn1ID:      {textBlock(turn1ID, "old text")},
		turn2ID:      {textBlock(turn2ID, "old answer")},
		compactionID: {textBlock(compactionID, priorSummary)},
		turn3ID:      {textBlock(turn3ID, "What about channels?")},
		turn4ID:      {textBlock(turn4ID, "Channels are the pipe between goroutines.")},
	}

	nav := &stubTurnNavigator{path: path}
	rdr := &stubTurnReader{blocksByTurn: blocksByTurn}
	wtr := &recordingTurnWriter{}
	prov := &stubLLMProvider{summary: wantSummary}

	svc := NewCompactionService(rdr, wtr, nav, prov, "", newLogger())

	result, err := svc.Compact(context.Background(), currentID)
	if err != nil {
		t.Fatalf("Compact failed: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}

	if result.Summary != wantSummary {
		t.Errorf("summary mismatch: got %q want %q", result.Summary, wantSummary)
	}

	// Should have created exactly one compaction turn.
	if len(wtr.createdTurns) != 1 {
		t.Fatalf("expected 1 created turn, got %d", len(wtr.createdTurns))
	}
	// The new compaction turn should be linked to the current (last) turn.
	ct := wtr.createdTurns[0]
	if ct.PrevTurnID == nil || *ct.PrevTurnID != currentID {
		t.Errorf("expected prev_turn_id=%q, got %v", currentID, ct.PrevTurnID)
	}
}

// TestCompact_NoNewTurnsSincePriorCompaction verifies that Compact returns nil
// (no-op) when there are no turns after the most recent compaction bookmark.
func TestCompact_NoNewTurnsSincePriorCompaction(t *testing.T) {
	const (
		threadID     = "thread-1"
		compactionID = "compaction-last"
	)

	// Path ends with the compaction turn — no new turns after it.
	path := []domainllm.Turn{
		makeTurn("turn-1", threadID, domainllm.TurnRoleUser, nil, nil),
		makeTurn(compactionID, threadID, domainllm.TurnRoleSystem, cptr("turn-1"), map[string]interface{}{
			"turn_type": domainllm.TurnTypeCompaction,
		}),
	}
	// The navigator is called with compactionID as the "current" turn.
	summary := "already compacted"
	blocksByTurn := map[string][]domainllm.TurnBlock{
		"turn-1":     {textBlock("turn-1", "hello")},
		compactionID: {textBlock(compactionID, summary)},
	}

	nav := &stubTurnNavigator{path: path}
	rdr := &stubTurnReader{blocksByTurn: blocksByTurn}
	wtr := &recordingTurnWriter{}
	prov := &stubLLMProvider{summary: "should not be called"}

	svc := NewCompactionService(rdr, wtr, nav, prov, "", newLogger())

	result, err := svc.Compact(context.Background(), compactionID)
	if err != nil {
		t.Fatalf("Compact failed: %v", err)
	}
	// No new turns → no compaction needed → nil result.
	if result != nil {
		t.Errorf("expected nil result when no new turns, got %+v", result)
	}
	// Writer should not have been called.
	if len(wtr.createdTurns) != 0 {
		t.Errorf("expected 0 turns created, got %d", len(wtr.createdTurns))
	}
}

// TestCompact_ProviderError verifies that Compact propagates LLM errors cleanly.
func TestCompact_ProviderError(t *testing.T) {
	const threadID = "thread-1"

	path := []domainllm.Turn{
		makeTurn("turn-1", threadID, domainllm.TurnRoleUser, nil, nil),
	}
	blocksByTurn := map[string][]domainllm.TurnBlock{
		"turn-1": {textBlock("turn-1", "hello")},
	}

	wantErr := errors.New("provider unavailable")
	nav := &stubTurnNavigator{path: path}
	rdr := &stubTurnReader{blocksByTurn: blocksByTurn}
	wtr := &recordingTurnWriter{}
	prov := &stubLLMProvider{err: wantErr}

	svc := NewCompactionService(rdr, wtr, nav, prov, "", newLogger())

	_, err := svc.Compact(context.Background(), "turn-1")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !errors.Is(err, wantErr) {
		t.Errorf("error chain mismatch: got %v, want chain containing %v", err, wantErr)
	}
	// Writer should not be called when LLM fails.
	if len(wtr.createdTurns) != 0 {
		t.Errorf("expected 0 turns created after provider error, got %d", len(wtr.createdTurns))
	}
}

// TestCompact_EmptyPath verifies that Compact fails gracefully on an empty path.
func TestCompact_EmptyPath(t *testing.T) {
	nav := &stubTurnNavigator{path: []domainllm.Turn{}}
	rdr := &stubTurnReader{blocksByTurn: map[string][]domainllm.TurnBlock{}}
	wtr := &recordingTurnWriter{}
	prov := &stubLLMProvider{summary: "never called"}

	svc := NewCompactionService(rdr, wtr, nav, prov, "", newLogger())

	_, err := svc.Compact(context.Background(), "turn-missing")
	if err == nil {
		t.Fatal("expected error for empty path, got nil")
	}
}

// =============================================================================
// Tests — buildTranscript
// =============================================================================

// TestBuildTranscript_IncludesUserAndAssistant verifies that user and assistant
// turns are rendered with their text, while system bookmark turns are omitted.
func TestBuildTranscript_IncludesUserAndAssistant(t *testing.T) {
	userText := "What is a goroutine?"
	assistText := "A goroutine is a lightweight thread."
	compSummary := "Old summary that should not appear."

	turns := []domainllm.Turn{
		{
			ID:       "t1",
			Role:     domainllm.TurnRoleUser,
			ThreadID: "th1",
			Blocks:   []domainllm.TurnBlock{textBlock("t1", userText)},
		},
		{
			ID:       "t2",
			Role:     domainllm.TurnRoleAssistant,
			ThreadID: "th1",
			Blocks:   []domainllm.TurnBlock{textBlock("t2", assistText)},
		},
		{
			ID:       "t3",
			Role:     domainllm.TurnRoleSystem,
			ThreadID: "th1",
			RequestParams: map[string]interface{}{
				"turn_type": domainllm.TurnTypeCompaction,
			},
			Blocks: []domainllm.TurnBlock{textBlock("t3", compSummary)},
		},
	}

	transcript := buildTranscript(turns)

	if !strings.Contains(transcript, "User: "+userText) {
		t.Errorf("transcript missing user text: %q", transcript)
	}
	if !strings.Contains(transcript, "Assistant: "+assistText) {
		t.Errorf("transcript missing assistant text: %q", transcript)
	}
	if strings.Contains(transcript, compSummary) {
		t.Errorf("transcript should not include compaction summary: %q", transcript)
	}
}

// TestBuildTranscript_ToolUseAndResult verifies tool_use and tool_result blocks
// are represented in the transcript with collapsed_content preferred for results.
func TestBuildTranscript_ToolUseAndResult(t *testing.T) {
	collapsed := "[Read /path/to/file: 512 chars]"

	turns := []domainllm.Turn{
		{
			ID:       "t1",
			Role:     domainllm.TurnRoleAssistant,
			ThreadID: "th1",
			Blocks: []domainllm.TurnBlock{
				{
					BlockType: domainllm.BlockTypeToolUse,
					Content: map[string]interface{}{
						"tool_name":   "str_replace_based_edit_tool",
						"tool_use_id": "call-1",
					},
				},
				{
					BlockType:        domainllm.BlockTypeToolResult,
					CollapsedContent: &collapsed,
					Content: map[string]interface{}{
						"tool_use_id": "call-1",
						"result":      "very long file content that was truncated",
					},
				},
			},
		},
	}

	transcript := buildTranscript(turns)

	if !strings.Contains(transcript, "str_replace_based_edit_tool") {
		t.Errorf("transcript missing tool name: %q", transcript)
	}
	if !strings.Contains(transcript, collapsed) {
		t.Errorf("transcript missing collapsed_content: %q", transcript)
	}
	// The full result text should NOT appear (collapsed takes priority).
	if strings.Contains(transcript, "very long file content") {
		t.Errorf("transcript should use collapsed_content, not full result: %q", transcript)
	}
}

// TestBuildTranscript_EmptyTurns verifies empty turns produce an empty transcript.
func TestBuildTranscript_EmptyTurns(t *testing.T) {
	transcript := buildTranscript(nil)
	if transcript != "" {
		t.Errorf("expected empty transcript, got %q", transcript)
	}
}

// =============================================================================
// Tests — BookmarkTurn helpers (domain turn methods)
// =============================================================================

func TestTurn_IsCompactionTurn(t *testing.T) {
	tests := []struct {
		name  string
		turn  domainllm.Turn
		wantC bool // IsCompactionTurn
		wantM bool // IsCollapseMarker
		wantB bool // IsBookmarkTurn
	}{
		{
			name: "compaction turn",
			turn: domainllm.Turn{
				Role: domainllm.TurnRoleSystem,
				RequestParams: map[string]interface{}{
					"turn_type": domainllm.TurnTypeCompaction,
				},
			},
			wantC: true, wantM: false, wantB: true,
		},
		{
			name: "collapse marker turn",
			turn: domainllm.Turn{
				Role: domainllm.TurnRoleSystem,
				RequestParams: map[string]interface{}{
					"turn_type": domainllm.TurnTypeCollapseMarker,
				},
			},
			wantC: false, wantM: true, wantB: true,
		},
		{
			name:  "regular user turn",
			turn:  domainllm.Turn{Role: domainllm.TurnRoleUser},
			wantC: false, wantM: false, wantB: false,
		},
		{
			name:  "regular assistant turn",
			turn:  domainllm.Turn{Role: domainllm.TurnRoleAssistant},
			wantC: false, wantM: false, wantB: false,
		},
		{
			name:  "system turn without turn_type",
			turn:  domainllm.Turn{Role: domainllm.TurnRoleSystem},
			wantC: false, wantM: false, wantB: false,
		},
		{
			name: "wrong role, correct turn_type",
			turn: domainllm.Turn{
				Role: domainllm.TurnRoleAssistant,
				RequestParams: map[string]interface{}{
					"turn_type": domainllm.TurnTypeCompaction,
				},
			},
			// Must be role=system AND turn_type=compaction.
			wantC: false, wantM: false, wantB: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.turn.IsCompactionTurn(); got != tc.wantC {
				t.Errorf("IsCompactionTurn() = %v, want %v", got, tc.wantC)
			}
			if got := tc.turn.IsCollapseMarker(); got != tc.wantM {
				t.Errorf("IsCollapseMarker() = %v, want %v", got, tc.wantM)
			}
			if got := tc.turn.IsBookmarkTurn(); got != tc.wantB {
				t.Errorf("IsBookmarkTurn() = %v, want %v", got, tc.wantB)
			}
		})
	}
}

// =============================================================================
// Tests — domain/llm bookmark helper functions
// =============================================================================

func TestFindLastCompactionTurn(t *testing.T) {
	makeCompaction := func(id string) domainllm.Turn {
		return domainllm.Turn{
			ID:   id,
			Role: domainllm.TurnRoleSystem,
			RequestParams: map[string]interface{}{
				"turn_type": domainllm.TurnTypeCompaction,
			},
		}
	}
	makeUser := func(id string) domainllm.Turn {
		return domainllm.Turn{ID: id, Role: domainllm.TurnRoleUser}
	}

	tests := []struct {
		name    string
		path    []domainllm.Turn
		wantIdx int
	}{
		{"empty path", nil, -1},
		{"no compaction", []domainllm.Turn{makeUser("t1"), makeUser("t2")}, -1},
		{"compaction at end", []domainllm.Turn{makeUser("t1"), makeCompaction("c1")}, 1},
		{"compaction in middle", []domainllm.Turn{makeUser("t1"), makeCompaction("c1"), makeUser("t2")}, 1},
		{
			"two compactions — most recent wins",
			[]domainllm.Turn{makeCompaction("c1"), makeUser("t1"), makeCompaction("c2")},
			2,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := domainllm.FindLastCompactionTurn(tc.path)
			if got != tc.wantIdx {
				t.Errorf("FindLastCompactionTurn = %d, want %d", got, tc.wantIdx)
			}
		})
	}
}

func TestFindLastCollapseMarker(t *testing.T) {
	makeMarker := func(id string) domainllm.Turn {
		return domainllm.Turn{
			ID:   id,
			Role: domainllm.TurnRoleSystem,
			RequestParams: map[string]interface{}{
				"turn_type": domainllm.TurnTypeCollapseMarker,
			},
		}
	}
	makeUser := func(id string) domainllm.Turn {
		return domainllm.Turn{ID: id, Role: domainllm.TurnRoleUser}
	}

	tests := []struct {
		name    string
		path    []domainllm.Turn
		wantIdx int
	}{
		{"empty", nil, -1},
		{"no marker", []domainllm.Turn{makeUser("t1")}, -1},
		{"marker at end", []domainllm.Turn{makeUser("t1"), makeMarker("m1")}, 1},
		{
			"two markers — most recent wins",
			[]domainllm.Turn{makeMarker("m1"), makeUser("t1"), makeMarker("m2")},
			2,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := domainllm.FindLastCollapseMarker(tc.path)
			if got != tc.wantIdx {
				t.Errorf("FindLastCollapseMarker = %d, want %d", got, tc.wantIdx)
			}
		})
	}
}

func TestExtractCompactionSummary(t *testing.T) {
	wantSummary := "Previously, goroutines were discussed."
	turn := domainllm.Turn{
		ID:   "c1",
		Role: domainllm.TurnRoleSystem,
		RequestParams: map[string]interface{}{
			"turn_type": domainllm.TurnTypeCompaction,
		},
		Blocks: []domainllm.TurnBlock{
			textBlock("c1", wantSummary),
		},
	}

	got := domainllm.ExtractCompactionSummary(turn)
	if got != wantSummary {
		t.Errorf("ExtractCompactionSummary = %q, want %q", got, wantSummary)
	}

	// Empty turn returns "".
	empty := domainllm.Turn{Role: domainllm.TurnRoleSystem}
	if got := domainllm.ExtractCompactionSummary(empty); got != "" {
		t.Errorf("expected empty, got %q", got)
	}
}
