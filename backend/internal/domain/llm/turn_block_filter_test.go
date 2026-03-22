package llm

import "testing"

func TestFilterWhitespaceOnlyThinkingBlocks(t *testing.T) {
	empty := ""
	whitespace := " \n\t  "
	thinking := "Real thinking"
	text := "Hello"

	blocks := []TurnBlock{
		{BlockType: BlockTypeThinking, Sequence: 0, TextContent: &whitespace},
		{BlockType: BlockTypeText, Sequence: 1, TextContent: &text},
		{BlockType: BlockTypeThinking, Sequence: 2, TextContent: &thinking},
		{BlockType: BlockTypeThinking, Sequence: 3, TextContent: &empty},
		{BlockType: BlockTypeToolUse, Sequence: 4},
		{BlockType: BlockTypeThinking, Sequence: 5, TextContent: nil},
	}

	got := FilterWhitespaceOnlyThinkingBlocks(blocks)

	if len(got) != 3 {
		t.Fatalf("expected 3 blocks after filtering, got %d", len(got))
	}
	if got[0].BlockType != BlockTypeText || got[0].Sequence != 1 {
		t.Fatalf("expected first kept block to be text seq=1, got type=%s seq=%d", got[0].BlockType, got[0].Sequence)
	}
	if got[1].BlockType != BlockTypeThinking || got[1].Sequence != 2 {
		t.Fatalf("expected kept thinking block seq=2, got type=%s seq=%d", got[1].BlockType, got[1].Sequence)
	}
	if got[2].BlockType != BlockTypeToolUse || got[2].Sequence != 4 {
		t.Fatalf("expected kept tool_use block seq=4, got type=%s seq=%d", got[2].BlockType, got[2].Sequence)
	}
}
