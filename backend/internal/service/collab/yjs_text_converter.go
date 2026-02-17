package collab

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	ycrdt "github.com/skyterra/y-crdt"
	collabSvc "meridian/internal/domain/services/collab"
)

// YjsTextConverter converts plain-text content into Yjs update bytes that are
// ancestry-compatible with the live Y.Doc stored in DocumentStore.
type YjsTextConverter struct {
	store collabSvc.DocumentStore
}

// NewYjsTextConverter creates a converter backed by the given DocumentStore.
func NewYjsTextConverter(store collabSvc.DocumentStore) *YjsTextConverter {
	return &YjsTextConverter{store: store}
}

// TextToUpdate loads the current Yjs state for documentID, diffs it against
// newContent, and returns a relative Yjs update that transforms the current
// state into newContent. Returns (nil, nil) when content is identical (no-op).
func (c *YjsTextConverter) TextToUpdate(ctx context.Context, documentID uuid.UUID, newContent string) (update []byte, err error) {
	// Panic recovery for all Yjs FFI calls (reuses safeEncodeStateAsUpdate pattern).
	defer func() {
		if r := recover(); r != nil {
			update = nil
			err = fmt.Errorf("yjs text converter panic: %v", r)
		}
	}()

	state, err := c.store.LoadState(ctx, documentID.String())
	if err != nil {
		return nil, fmt.Errorf("load yjs state: %w", err)
	}

	// Build base doc from persisted state to establish CRDT lineage.
	baseDoc := ycrdt.NewDoc("base", true, ycrdt.DefaultGCFilter, nil, false)
	if len(state) > 0 {
		ycrdt.ApplyUpdate(baseDoc, state, "converter-base")
	}

	baseText := baseDoc.GetText("content")
	currentContent := ""
	if baseText != nil {
		currentContent = baseText.ToString()
	}

	if currentContent == newContent {
		return nil, nil
	}

	// Capture base state vector before mutations.
	baseStateVector := ycrdt.EncodeStateVector(baseDoc, nil, ycrdt.NewUpdateEncoderV1())

	// Clone base state into target doc so it shares CRDT ancestry.
	targetDoc := ycrdt.NewDoc("target", true, ycrdt.DefaultGCFilter, nil, false)
	if len(state) > 0 {
		ycrdt.ApplyUpdate(targetDoc, state, "converter-target")
	}

	targetText := targetDoc.GetText("content")

	// Replace content using insert-at-0 + delete strategy.
	// Why not granular diffs: the y-crdt Go library panics when inserting at
	// position == Length() on a doc with deleted tombstones at the end of the
	// internal linked list (nil pointer in MinimizeAttributeChanges). The
	// insert-at-0 approach avoids this bug while maintaining full CRDT lineage.
	oldLen := targetText.Length()
	if len(newContent) > 0 {
		targetText.Insert(0, newContent, nil)
	}
	if oldLen > 0 {
		targetText.Delete(utf16Len(newContent), oldLen)
	}

	// Encode only the delta (changes relative to base).
	update = ycrdt.EncodeStateAsUpdate(targetDoc, baseStateVector)
	return update, nil
}

// utf16Len returns the number of UTF-16 code units needed to represent s.
// BMP characters count as 1; supplementary plane characters (emoji etc.)
// count as 2 (surrogate pair).
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2 // surrogate pair
		} else {
			n++
		}
	}
	return n
}
