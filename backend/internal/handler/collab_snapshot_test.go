package handler

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/skyterra/y-crdt"
	"meridian/internal/config"
	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	"meridian/internal/domain/repositories"
	"meridian/internal/httputil"
)

type snapshotTestStore struct {
	snapshot       *collabModels.SnapshotWithState
	getSnapshotErr error
}

func (s *snapshotTestStore) LoadState(_ context.Context, _ string) ([]byte, error) {
	return nil, nil
}

func (s *snapshotTestStore) SaveState(_ context.Context, _ string, _ []byte, _ string, _ string) error {
	return nil
}

func (s *snapshotTestStore) SaveSnapshot(
	_ context.Context,
	_ string,
	_ []byte,
	_ string,
	_ *string,
	_ *string,
) (string, error) {
	return "", nil
}

func (s *snapshotTestStore) ListSnapshots(_ context.Context, _ string, _, _ int) ([]collabModels.Snapshot, int, error) {
	return nil, 0, nil
}

func (s *snapshotTestStore) GetSnapshot(_ context.Context, _ string) (*collabModels.SnapshotWithState, error) {
	if s.getSnapshotErr != nil {
		return nil, s.getSnapshotErr
	}
	if s.snapshot == nil {
		return nil, domain.NewNotFoundError("snapshot", "snapshot not found")
	}
	return s.snapshot, nil
}

func (s *snapshotTestStore) DeleteSnapshot(_ context.Context, _ string) error {
	return nil
}

func (s *snapshotTestStore) DeleteExpiredAutoSnapshots(_ context.Context, _ int) (int64, error) {
	return 0, nil
}

type snapshotTestResolver struct {
	allowed bool
	err     error
}

func (r *snapshotTestResolver) ResolveDocument(_ context.Context, _ string) (*collabModels.CollabDocRef, error) {
	return nil, nil
}

func (r *snapshotTestResolver) VerifyOwnership(_ context.Context, _, _ string) (bool, error) {
	if r.err != nil {
		return false, r.err
	}
	return r.allowed, nil
}

type noopSnapshotTxManager struct{}

func (noopSnapshotTxManager) ExecTx(ctx context.Context, fn repositories.TxFn) error {
	return fn(ctx)
}

func newSnapshotHandlerForTest(store *snapshotTestStore, resolver *snapshotTestResolver) *CollabSnapshotHandler {
	return NewCollabSnapshotHandler(
		store,
		resolver,
		noopSnapshotTxManager{},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&config.Config{Environment: "test"},
	)
}

func newSnapshotContentRequest(docID, snapshotID, userID string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req = httputil.WithUserID(req, userID)
	req.SetPathValue("id", docID)
	req.SetPathValue("snapshotId", snapshotID)
	return req
}

func TestGetSnapshotContent_Success(t *testing.T) {
	docID := uuid.MustParse("11111111-1111-1111-1111-111111111111").String()
	snapshotID := uuid.MustParse("22222222-2222-2222-2222-222222222222").String()
	userID := uuid.MustParse("33333333-3333-3333-3333-333333333333").String()

	store := &snapshotTestStore{
		snapshot: &collabModels.SnapshotWithState{
			Snapshot: collabModels.Snapshot{
				ID:         snapshotID,
				DocumentID: docID,
				CreatedAt:  time.Now(),
			},
			YjsState: buildSnapshotState(t, "Recovered snapshot content"),
		},
	}
	h := newSnapshotHandlerForTest(store, &snapshotTestResolver{allowed: true})

	rr := httptest.NewRecorder()
	h.GetSnapshotContent(rr, newSnapshotContentRequest(docID, snapshotID, userID))

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rr.Code)
	}

	var resp struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Content != "Recovered snapshot content" {
		t.Fatalf("expected decoded content %q, got %q", "Recovered snapshot content", resp.Content)
	}
}

func TestGetSnapshotContent_InvalidUUID(t *testing.T) {
	validDocID := uuid.MustParse("11111111-1111-1111-1111-111111111111").String()
	validSnapshotID := uuid.MustParse("22222222-2222-2222-2222-222222222222").String()
	userID := uuid.MustParse("33333333-3333-3333-3333-333333333333").String()

	tests := []struct {
		name         string
		docID        string
		snapshotID   string
		expectedText string
	}{
		{
			name:         "invalid document uuid",
			docID:        "not-a-uuid",
			snapshotID:   validSnapshotID,
			expectedText: "Document identifier must be a valid UUID",
		},
		{
			name:         "invalid snapshot uuid",
			docID:        validDocID,
			snapshotID:   "not-a-uuid",
			expectedText: "Snapshot identifier must be a valid UUID",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newSnapshotHandlerForTest(&snapshotTestStore{}, &snapshotTestResolver{allowed: true})
			rr := httptest.NewRecorder()

			h.GetSnapshotContent(rr, newSnapshotContentRequest(tt.docID, tt.snapshotID, userID))

			if rr.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d", http.StatusBadRequest, rr.Code)
			}

			var problem struct {
				Detail string `json:"detail"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &problem); err != nil {
				t.Fatalf("decode problem response: %v", err)
			}
			if problem.Detail != tt.expectedText {
				t.Fatalf("expected detail %q, got %q", tt.expectedText, problem.Detail)
			}
		})
	}
}

func TestGetSnapshotContent_DocumentSnapshotMismatch(t *testing.T) {
	docID := uuid.MustParse("11111111-1111-1111-1111-111111111111").String()
	otherDocID := uuid.MustParse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa").String()
	snapshotID := uuid.MustParse("22222222-2222-2222-2222-222222222222").String()
	userID := uuid.MustParse("33333333-3333-3333-3333-333333333333").String()

	store := &snapshotTestStore{
		snapshot: &collabModels.SnapshotWithState{
			Snapshot: collabModels.Snapshot{
				ID:         snapshotID,
				DocumentID: otherDocID,
				CreatedAt:  time.Now(),
			},
			YjsState: buildSnapshotState(t, "ignored"),
		},
	}
	h := newSnapshotHandlerForTest(store, &snapshotTestResolver{allowed: true})

	rr := httptest.NewRecorder()
	h.GetSnapshotContent(rr, newSnapshotContentRequest(docID, snapshotID, userID))

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, rr.Code)
	}

	var problem struct {
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &problem); err != nil {
		t.Fatalf("decode problem response: %v", err)
	}
	if problem.Detail != "Snapshot not found for this document" {
		t.Fatalf("expected mismatch detail, got %q", problem.Detail)
	}
}

func TestGetSnapshotContent_OwnershipDenied(t *testing.T) {
	docID := uuid.MustParse("11111111-1111-1111-1111-111111111111").String()
	snapshotID := uuid.MustParse("22222222-2222-2222-2222-222222222222").String()
	userID := uuid.MustParse("33333333-3333-3333-3333-333333333333").String()

	h := newSnapshotHandlerForTest(&snapshotTestStore{}, &snapshotTestResolver{allowed: false})
	rr := httptest.NewRecorder()
	h.GetSnapshotContent(rr, newSnapshotContentRequest(docID, snapshotID, userID))

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected status %d, got %d", http.StatusForbidden, rr.Code)
	}

	var problem struct {
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &problem); err != nil {
		t.Fatalf("decode problem response: %v", err)
	}
	if problem.Detail != "access denied" {
		t.Fatalf("expected forbidden detail %q, got %q", "access denied", problem.Detail)
	}
}

func TestGetSnapshotContent_EmptyStateReturnsEmptyContent(t *testing.T) {
	docID := uuid.MustParse("11111111-1111-1111-1111-111111111111").String()
	snapshotID := uuid.MustParse("22222222-2222-2222-2222-222222222222").String()
	userID := uuid.MustParse("33333333-3333-3333-3333-333333333333").String()

	store := &snapshotTestStore{
		snapshot: &collabModels.SnapshotWithState{
			Snapshot: collabModels.Snapshot{
				ID:         snapshotID,
				DocumentID: docID,
				CreatedAt:  time.Now(),
			},
			YjsState: []byte{},
		},
	}
	h := newSnapshotHandlerForTest(store, &snapshotTestResolver{allowed: true})

	rr := httptest.NewRecorder()
	h.GetSnapshotContent(rr, newSnapshotContentRequest(docID, snapshotID, userID))

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rr.Code)
	}

	var resp struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Content != "" {
		t.Fatalf("expected empty content for empty yjs_state, got %q", resp.Content)
	}
}

func buildSnapshotState(t *testing.T, content string) []byte {
	t.Helper()

	doc := ycrdt.NewDoc("snapshot-test", true, ycrdt.DefaultGCFilter, nil, false)
	text := doc.GetText("content")
	doc.Transact(func(_ *ycrdt.Transaction) {
		text.Insert(0, content, nil)
	}, nil)
	return ycrdt.EncodeStateAsUpdate(doc, nil)
}
