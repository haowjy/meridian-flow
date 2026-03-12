package collab

import (
	"errors"
	"strings"
	"testing"

	ycrdt "github.com/haowjy/y-crdt"
)

// --- helpers ---

// buildDocState creates a Yjs document with the given text content and returns
// the full state as update bytes.
func buildDocState(t *testing.T, content string) []byte {
	t.Helper()
	doc := ycrdt.NewDoc("test-doc", true, ycrdt.DefaultGCFilter, nil, false)
	text := doc.GetText("content")
	doc.Transact(func(_ *ycrdt.Transaction) {
		text.Insert(0, content, nil)
	}, nil)
	return ycrdt.EncodeStateAsUpdate(doc, nil)
}

// applyAndRead creates a base doc from baseState, applies the update, and
// returns the resulting text content.
func applyAndRead(t *testing.T, baseState, update []byte) string {
	t.Helper()
	doc := ycrdt.NewDoc("verify-doc", true, ycrdt.DefaultGCFilter, nil, false)
	if len(baseState) > 0 {
		ycrdt.ApplyUpdate(doc, baseState, "base")
	}
	if len(update) > 0 {
		ycrdt.ApplyUpdate(doc, update, "update")
	}
	text := doc.GetText("content")
	if text == nil {
		return ""
	}
	return text.ToString()
}

// applyUpdateToState applies an update to baseState and returns the combined state bytes.
// Used by tests that need projected state for generating subsequent proposals.
func applyUpdateToState(t *testing.T, baseState, update []byte) []byte {
	t.Helper()
	doc := ycrdt.NewDoc("apply-state", true, ycrdt.DefaultGCFilter, nil, false)
	if len(baseState) > 0 {
		ycrdt.ApplyUpdate(doc, baseState, "base")
	}
	if len(update) > 0 {
		ycrdt.ApplyUpdate(doc, update, "update")
	}
	return ycrdt.EncodeStateAsUpdate(doc, nil)
}

// --- tests (full-doc replacement, edit=nil) ---

func TestTextToUpdate_SimpleReplacement(t *testing.T) {
	baseState := buildDocState(t, "hello world")

	update, err := TextToUpdate(baseState, "hello Go", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if update == nil {
		t.Fatal("expected non-nil update for different content")
	}

	got := applyAndRead(t, baseState, update)
	if got != "hello Go" {
		t.Errorf("expected %q, got %q", "hello Go", got)
	}
}

func TestTextToUpdate_PureInsertion(t *testing.T) {
	baseState := buildDocState(t, "hello")

	update, err := TextToUpdate(baseState, "hello world", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if update == nil {
		t.Fatal("expected non-nil update")
	}

	got := applyAndRead(t, baseState, update)
	if got != "hello world" {
		t.Errorf("expected %q, got %q", "hello world", got)
	}
}

func TestTextToUpdate_PureDeletion(t *testing.T) {
	baseState := buildDocState(t, "hello world")

	update, err := TextToUpdate(baseState, "hello", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if update == nil {
		t.Fatal("expected non-nil update")
	}

	got := applyAndRead(t, baseState, update)
	if got != "hello" {
		t.Errorf("expected %q, got %q", "hello", got)
	}
}

func TestTextToUpdate_MultiLine(t *testing.T) {
	original := "line one\nline two\nline three"
	replacement := "line one\nline TWO\nline three\nline four"

	baseState := buildDocState(t, original)

	update, err := TextToUpdate(baseState, replacement, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got := applyAndRead(t, baseState, update)
	if got != replacement {
		t.Errorf("expected %q, got %q", replacement, got)
	}
}

func TestTextToUpdate_Emoji(t *testing.T) {
	// 🎉 is U+1F389 — a supplementary character (2 UTF-16 code units).
	original := "hello 🎉 world"
	replacement := "hello 🎉 Go 🚀"

	baseState := buildDocState(t, original)

	update, err := TextToUpdate(baseState, replacement, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got := applyAndRead(t, baseState, update)
	if got != replacement {
		t.Errorf("expected %q, got %q", replacement, got)
	}
}

func TestTextToUpdate_IdenticalContent(t *testing.T) {
	baseState := buildDocState(t, "no change")

	update, err := TextToUpdate(baseState, "no change", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if update != nil {
		t.Errorf("expected nil update for identical content, got %d bytes", len(update))
	}
}

func TestTextToUpdate_EmptyBase(t *testing.T) {
	// Empty doc — no prior state.
	baseState := buildDocState(t, "")

	update, err := TextToUpdate(baseState, "brand new content", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if update == nil {
		t.Fatal("expected non-nil update")
	}

	got := applyAndRead(t, baseState, update)
	if got != "brand new content" {
		t.Errorf("expected %q, got %q", "brand new content", got)
	}
}

func TestTextToUpdate_EmptyNew(t *testing.T) {
	baseState := buildDocState(t, "delete me")

	update, err := TextToUpdate(baseState, "", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if update == nil {
		t.Fatal("expected non-nil update")
	}

	got := applyAndRead(t, baseState, update)
	if got != "" {
		t.Errorf("expected empty string, got %q", got)
	}
}

func TestTextToUpdate_NilState(t *testing.T) {
	// No persisted state at all (nil bytes) — full insert of newContent, no panic.
	update, err := TextToUpdate(nil, "new content", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if update == nil {
		t.Fatal("expected non-nil update")
	}

	got := applyAndRead(t, nil, update)
	if got != "new content" {
		t.Errorf("expected %q, got %q", "new content", got)
	}
}

func TestTextToUpdate_EmptyStateBytes(t *testing.T) {
	// Empty byte slice (LoadState returns []byte{} for NULL yjs_state) — no panic.
	update, err := TextToUpdate([]byte{}, "new content", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if update == nil {
		t.Fatal("expected non-nil update")
	}

	got := applyAndRead(t, nil, update)
	if got != "new content" {
		t.Errorf("expected %q, got %q", "new content", got)
	}
}

func TestTextToUpdate_RoundTrip(t *testing.T) {
	// Multiple sequential edits, each building on the previous state.
	steps := []string{
		"initial content",
		"initial content with more",
		"modified content with more",
		"modified",
		"modified 🎉 emoji",
	}

	state := buildDocState(t, steps[0])

	for i := 1; i < len(steps); i++ {
		update, err := TextToUpdate(state, steps[i], nil)
		if err != nil {
			t.Fatalf("step %d: unexpected error: %v", i, err)
		}
		if update == nil {
			t.Fatalf("step %d: expected non-nil update", i)
		}

		// Apply update to get new combined state for next iteration.
		doc := ycrdt.NewDoc("round-trip", true, ycrdt.DefaultGCFilter, nil, false)
		ycrdt.ApplyUpdate(doc, state, "base")
		ycrdt.ApplyUpdate(doc, update, "delta")

		got := doc.GetText("content").ToString()
		if got != steps[i] {
			t.Fatalf("step %d: expected %q, got %q", i, steps[i], got)
		}

		// Persist combined state for next step.
		state = ycrdt.EncodeStateAsUpdate(doc, nil)
	}
}

// --- tests (targeted positional diffs) ---

func TestTextToUpdate_PositionalEdit_Simple(t *testing.T) {
	content := "hello world"
	baseState := buildDocState(t, content)

	// Replace "world" with "Go" using positional edit
	edit := &TextEdit{
		OldText:  "world",
		NewText:  "Go",
		Position: strings.Index(content, "world"),
	}

	newContent := strings.Replace(content, "world", "Go", 1)
	update, err := TextToUpdate(baseState, newContent, edit)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if update == nil {
		t.Fatal("expected non-nil update")
	}

	got := applyAndRead(t, baseState, update)
	if got != "hello Go" {
		t.Errorf("expected %q, got %q", "hello Go", got)
	}
}

func TestTextToUpdate_PositionalEdit_InsertAtEnd(t *testing.T) {
	// This is the case that previously panicked with MinimizeAttributeChanges nil deref.
	content := "hello"
	baseState := buildDocState(t, content)

	// Insert " world" at end (no old text to delete, just insert)
	edit := &TextEdit{
		OldText:  "",
		NewText:  " world",
		Position: len(content),
	}

	update, err := TextToUpdate(baseState, "hello world", edit)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if update == nil {
		t.Fatal("expected non-nil update")
	}

	got := applyAndRead(t, baseState, update)
	if got != "hello world" {
		t.Errorf("expected %q, got %q", "hello world", got)
	}
}

func TestTextToUpdate_PositionalEdit_Emoji(t *testing.T) {
	content := "hello 🎉 world"
	baseState := buildDocState(t, content)

	// Replace "world" (after emoji) with "Go 🚀"
	edit := &TextEdit{
		OldText:  "world",
		NewText:  "Go 🚀",
		Position: strings.Index(content, "world"),
	}

	newContent := strings.Replace(content, "world", "Go 🚀", 1)
	update, err := TextToUpdate(baseState, newContent, edit)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got := applyAndRead(t, baseState, update)
	if got != newContent {
		t.Errorf("expected %q, got %q", newContent, got)
	}
}

func TestTextToUpdate_PositionalEdit_ConcurrentDifferentSections(t *testing.T) {
	// Simulate two str_replace calls in one turn targeting different sections.
	// Both updates are generated against the SAME base state (the bug scenario).
	// With positional diffs, they should merge correctly without duplication.
	content := "section one\nsection two\nsection three"
	baseState := buildDocState(t, content)

	// Edit 1: replace "one" -> "ONE" in section one
	edit1 := &TextEdit{
		OldText:  "one",
		NewText:  "ONE",
		Position: strings.Index(content, "one"),
	}
	newContent1 := strings.Replace(content, "one", "ONE", 1)
	update1, err := TextToUpdate(baseState, newContent1, edit1)
	if err != nil {
		t.Fatalf("edit 1: unexpected error: %v", err)
	}

	// Edit 2: replace "three" -> "THREE" in section three (against SAME base)
	edit2 := &TextEdit{
		OldText:  "three",
		NewText:  "THREE",
		Position: strings.LastIndex(content, "three"),
	}
	newContent2 := strings.Replace(content, "three", "THREE", 1)
	update2, err := TextToUpdate(baseState, newContent2, edit2)
	if err != nil {
		t.Fatalf("edit 2: unexpected error: %v", err)
	}

	// Apply both updates to the same base — should merge cleanly
	doc := ycrdt.NewDoc("merge-doc", true, ycrdt.DefaultGCFilter, nil, false)
	ycrdt.ApplyUpdate(doc, baseState, "base")
	ycrdt.ApplyUpdate(doc, update1, "edit1")
	ycrdt.ApplyUpdate(doc, update2, "edit2")

	got := doc.GetText("content").ToString()
	want := "section ONE\nsection two\nsection THREE"
	if got != want {
		t.Errorf("concurrent edits produced wrong result:\nwant: %q\ngot:  %q", want, got)
	}
}

// --- tests (bounds checking / anchor validation) ---

func TestTextToUpdate_PositionalEdit_OutOfBounds(t *testing.T) {
	content := "hello"
	baseState := buildDocState(t, content)

	edit := &TextEdit{
		OldText:  "world",
		NewText:  "Go",
		Position: 10, // beyond content length
	}

	_, err := TextToUpdate(baseState, "hello Go", edit)
	if err == nil {
		t.Fatal("expected error for out-of-bounds position")
	}
	if !errors.Is(err, ErrEditPositionMismatch) {
		t.Errorf("expected ErrEditPositionMismatch, got: %v", err)
	}
}

func TestTextToUpdate_PositionalEdit_AnchorMismatch(t *testing.T) {
	// Position is valid but text at that position doesn't match OldText.
	// This simulates Bug 2: position computed against ai_content but state is base-only.
	content := "hello world"
	baseState := buildDocState(t, content)

	edit := &TextEdit{
		OldText:  "xyz", // not present at position 6
		NewText:  "Go",
		Position: 6,
	}

	_, err := TextToUpdate(baseState, "hello Go", edit)
	if err == nil {
		t.Fatal("expected error for anchor mismatch")
	}
	if !errors.Is(err, ErrEditPositionMismatch) {
		t.Errorf("expected ErrEditPositionMismatch, got: %v", err)
	}
}

func TestTextToUpdate_PositionalEdit_NegativePosition(t *testing.T) {
	baseState := buildDocState(t, "hello")

	edit := &TextEdit{
		OldText:  "hello",
		NewText:  "world",
		Position: -1,
	}

	_, err := TextToUpdate(baseState, "world", edit)
	if err == nil {
		t.Fatal("expected error for negative position")
	}
	if !errors.Is(err, ErrEditPositionMismatch) {
		t.Errorf("expected ErrEditPositionMismatch, got: %v", err)
	}
}

func TestFindEditPosition(t *testing.T) {
	tests := []struct {
		name    string
		content string
		old     string
		want    int
	}{
		{"found", "hello world", "world", 6},
		{"not found", "hello world", "xyz", -1},
		{"ambiguous", "hello hello", "hello", -1},
		{"at start", "hello world", "hello", 0},
		{"empty old", "hello", "", -1}, // empty string matches everywhere -> ambiguous
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := FindEditPosition(tt.content, tt.old)
			if got != tt.want {
				t.Errorf("FindEditPosition(%q, %q) = %d, want %d", tt.content, tt.old, got, tt.want)
			}
		})
	}
}

func TestUtf16Len(t *testing.T) {
	tests := []struct {
		name string
		text string
		want int
	}{
		{"empty", "", 0},
		{"ascii", "hello", 5},
		{"emoji", "🎉", 2},
		{"mixed", "hi🎉!", 5}, // 2+2+1
		{"BMP accented", "café", 4},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := utf16Len(tt.text)
			if got != tt.want {
				t.Errorf("utf16Len(%q) = %d, want %d", tt.text, got, tt.want)
			}
		})
	}
}
