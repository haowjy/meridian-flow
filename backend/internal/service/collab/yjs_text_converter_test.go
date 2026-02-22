package collab

import (
	"context"
	"testing"

	"github.com/google/uuid"
	ycrdt "github.com/skyterra/y-crdt"
	collabModels "meridian/internal/domain/models/collab"
)

// --- fake DocumentStore for tests ---

type fakeConverterStore struct {
	state []byte
}

func (s *fakeConverterStore) LoadState(_ context.Context, _ string) ([]byte, error) {
	return s.state, nil
}

func (s *fakeConverterStore) LoadContentForBootstrap(_ context.Context, _ string) (string, error) {
	return "", nil
}

func (s *fakeConverterStore) SaveState(context.Context, string, []byte, string, string) error {
	return nil
}

func (s *fakeConverterStore) SaveSnapshot(context.Context, string, []byte, string, *string, *string) (string, error) {
	return "", nil
}

func (s *fakeConverterStore) ListSnapshots(context.Context, string, int, int) ([]collabModels.Snapshot, int, error) {
	return nil, 0, nil
}

func (s *fakeConverterStore) GetSnapshot(context.Context, string) (*collabModels.SnapshotWithState, error) {
	return nil, nil
}

func (s *fakeConverterStore) DeleteSnapshot(context.Context, string) error { return nil }

func (s *fakeConverterStore) DeleteExpiredAutoSnapshots(context.Context, int) (int64, error) {
	return 0, nil
}

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

// --- tests ---

func TestYjsTextConverter_SimpleReplacement(t *testing.T) {
	baseState := buildDocState(t, "hello world")
	store := &fakeConverterStore{state: baseState}
	conv := NewYjsTextConverter(store)

	update, err := conv.TextToUpdate(context.Background(), uuid.New(), "hello Go")
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

func TestYjsTextConverter_PureInsertion(t *testing.T) {
	baseState := buildDocState(t, "hello")
	store := &fakeConverterStore{state: baseState}
	conv := NewYjsTextConverter(store)

	update, err := conv.TextToUpdate(context.Background(), uuid.New(), "hello world")
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

func TestYjsTextConverter_PureDeletion(t *testing.T) {
	baseState := buildDocState(t, "hello world")
	store := &fakeConverterStore{state: baseState}
	conv := NewYjsTextConverter(store)

	update, err := conv.TextToUpdate(context.Background(), uuid.New(), "hello")
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

func TestYjsTextConverter_MultiLine(t *testing.T) {
	original := "line one\nline two\nline three"
	replacement := "line one\nline TWO\nline three\nline four"

	baseState := buildDocState(t, original)
	store := &fakeConverterStore{state: baseState}
	conv := NewYjsTextConverter(store)

	update, err := conv.TextToUpdate(context.Background(), uuid.New(), replacement)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got := applyAndRead(t, baseState, update)
	if got != replacement {
		t.Errorf("expected %q, got %q", replacement, got)
	}
}

func TestYjsTextConverter_Emoji(t *testing.T) {
	// 🎉 is U+1F389 — a supplementary character (2 UTF-16 code units).
	original := "hello 🎉 world"
	replacement := "hello 🎉 Go 🚀"

	baseState := buildDocState(t, original)
	store := &fakeConverterStore{state: baseState}
	conv := NewYjsTextConverter(store)

	update, err := conv.TextToUpdate(context.Background(), uuid.New(), replacement)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	got := applyAndRead(t, baseState, update)
	if got != replacement {
		t.Errorf("expected %q, got %q", replacement, got)
	}
}

func TestYjsTextConverter_IdenticalContent(t *testing.T) {
	baseState := buildDocState(t, "no change")
	store := &fakeConverterStore{state: baseState}
	conv := NewYjsTextConverter(store)

	update, err := conv.TextToUpdate(context.Background(), uuid.New(), "no change")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if update != nil {
		t.Errorf("expected nil update for identical content, got %d bytes", len(update))
	}
}

func TestYjsTextConverter_EmptyBase(t *testing.T) {
	// Empty doc — no prior state.
	baseState := buildDocState(t, "")
	store := &fakeConverterStore{state: baseState}
	conv := NewYjsTextConverter(store)

	update, err := conv.TextToUpdate(context.Background(), uuid.New(), "brand new content")
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

func TestYjsTextConverter_EmptyNew(t *testing.T) {
	baseState := buildDocState(t, "delete me")
	store := &fakeConverterStore{state: baseState}
	conv := NewYjsTextConverter(store)

	update, err := conv.TextToUpdate(context.Background(), uuid.New(), "")
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

func TestYjsTextConverter_NilState(t *testing.T) {
	// No persisted state at all (nil bytes).
	store := &fakeConverterStore{state: nil}
	conv := NewYjsTextConverter(store)

	update, err := conv.TextToUpdate(context.Background(), uuid.New(), "new content")
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

func TestYjsTextConverter_RoundTrip(t *testing.T) {
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
		store := &fakeConverterStore{state: state}
		conv := NewYjsTextConverter(store)

		update, err := conv.TextToUpdate(context.Background(), uuid.New(), steps[i])
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
