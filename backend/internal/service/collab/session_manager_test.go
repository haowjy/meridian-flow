package collab

import (
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

func TestDocumentSessionCurrentStateLocked_DerivesContentFromAppliedUpdate(t *testing.T) {
	source := ycrdt.NewDoc("source-doc", true, ycrdt.DefaultGCFilter, nil, false)
	sourceText := source.GetText("content")
	source.Transact(func(tr *ycrdt.Transaction) {
		sourceText.Insert(0, "hello from update", nil)
	}, nil)
	update := ycrdt.EncodeStateAsUpdate(source, nil)

	session := &DocumentSession{
		docID: "doc-1",
		doc:   ycrdt.NewDoc("doc-1", true, ycrdt.DefaultGCFilter, nil, false),
	}

	if err := safeApplyUpdate(session.doc, update, "test"); err != nil {
		t.Fatalf("apply update: %v", err)
	}

	state, content, err := session.currentStateLocked()
	if err != nil {
		t.Fatalf("currentStateLocked returned error: %v", err)
	}
	if len(state) == 0 {
		t.Fatal("expected encoded state to be non-empty")
	}
	if content != "hello from update" {
		t.Fatalf("expected derived content %q, got %q", "hello from update", content)
	}
}
