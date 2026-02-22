package collab

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"
	collabSvc "meridian/internal/domain/services/collab"
)

// TextEdit describes a targeted edit within the document content.
// When provided to TextToUpdate, it enables positional delete+insert instead of
// full-doc replacement, producing smaller CRDT updates that merge correctly when
// multiple edits are applied against the same base state.
type TextEdit struct {
	OldText  string // text being replaced
	NewText  string // replacement text
	Position int    // byte offset of OldText in the current content
}

// YjsTextConverter converts plain-text content into Yjs update bytes that are
// ancestry-compatible with the live Y.Doc stored in DocumentStateStore.
type YjsTextConverter struct {
	store collabSvc.DocumentStateStore
}

// NewYjsTextConverter creates a converter backed by the given DocumentStateStore.
func NewYjsTextConverter(store collabSvc.DocumentStateStore) *YjsTextConverter {
	return &YjsTextConverter{store: store}
}

// TextToUpdate loads the current Yjs state for documentID, diffs it against
// newContent, and returns a relative Yjs update that transforms the current
// state into newContent. Returns (nil, nil) when content is identical (no-op).
//
// If edit is provided, uses targeted positional diff (delete old at position,
// insert new at position). Otherwise falls back to full-doc replacement for
// backward compat.
func (c *YjsTextConverter) TextToUpdate(ctx context.Context, documentID uuid.UUID, newContent string, edit *TextEdit) (update []byte, err error) {
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

	if edit != nil {
		// Targeted positional diff: delete old text at position, insert new text.
		// This produces a minimal CRDT update that merges correctly when multiple
		// edits hit different regions of the same document.
		utf16Pos := utf16Len(currentContent[:edit.Position])
		oldUTF16Len := utf16Len(edit.OldText)

		if oldUTF16Len > 0 {
			targetText.Delete(utf16Pos, oldUTF16Len)
		}
		if len(edit.NewText) > 0 {
			targetText.Insert(utf16Pos, edit.NewText, nil)
		}
	} else {
		// Full-doc replacement fallback for callers that don't provide edit info.
		oldLen := targetText.Length()
		if len(newContent) > 0 {
			targetText.Insert(0, newContent, nil)
		}
		if oldLen > 0 {
			targetText.Delete(utf16Len(newContent), oldLen)
		}
	}

	// Encode only the delta (changes relative to base).
	update = ycrdt.EncodeStateAsUpdate(targetDoc, baseStateVector)
	return update, nil
}

// FindEditPosition locates oldText within content and returns the byte offset.
// Returns -1 if not found or if there are multiple matches (ambiguous).
func FindEditPosition(content, oldText string) int {
	idx := strings.Index(content, oldText)
	if idx == -1 {
		return -1
	}
	// Check for ambiguous match (multiple occurrences)
	if strings.Index(content[idx+1:], oldText) != -1 {
		return -1
	}
	return idx
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
