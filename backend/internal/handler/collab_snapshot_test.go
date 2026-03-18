package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"
	"meridian/internal/config"
	"meridian/internal/domain"
	collabModels "meridian/internal/domain/models/collab"
	"meridian/internal/domain/repositories"
	"meridian/internal/httputil"
)

type snapshotTestSnapshotStore struct {
	snapshot       *collabModels.SnapshotWithState
	getSnapshotErr error

	saveSnapshotCalls int
	savedDocumentID   string
	savedState        []byte
	savedSnapshotType string
	savedName         *string
	savedCreatedBy    *string
	saveSnapshotID    string
	saveSnapshotErr   error
}

func (s *snapshotTestSnapshotStore) SaveSnapshot(
	_ context.Context,
	docID string,
	state []byte,
	snapshotType string,
	name *string,
	createdBy *string,
) (string, error) {
	if s.saveSnapshotErr != nil {
		return "", s.saveSnapshotErr
	}

	s.saveSnapshotCalls++
	s.savedDocumentID = docID
	s.savedState = state
	s.savedSnapshotType = snapshotType
	s.savedName = name
	s.savedCreatedBy = createdBy

	if s.saveSnapshotID != "" {
		return s.saveSnapshotID, nil
	}
	return "", nil
}

func (s *snapshotTestSnapshotStore) ListSnapshots(_ context.Context, _ string, _, _ int) ([]collabModels.Snapshot, int, error) {
	return nil, 0, nil
}

func (s *snapshotTestSnapshotStore) GetSnapshot(_ context.Context, _ string) (*collabModels.SnapshotWithState, error) {
	if s.getSnapshotErr != nil {
		return nil, s.getSnapshotErr
	}
	if s.snapshot == nil {
		return nil, domain.NewNotFoundError("snapshot", "snapshot not found")
	}
	return s.snapshot, nil
}

func (s *snapshotTestSnapshotStore) DeleteSnapshot(_ context.Context, _ string) error {
	return nil
}

func (s *snapshotTestSnapshotStore) DeleteExpiredAutoSnapshots(_ context.Context, _ int) (int64, error) {
	return 0, nil
}

type noopSnapshotStateStore struct{}

func (s *noopSnapshotStateStore) LoadState(_ context.Context, _ string) ([]byte, error) {
	return nil, nil
}

func (s *noopSnapshotStateStore) SaveState(_ context.Context, _ string, _ []byte, _ string) error {
	return nil
}

type noopSnapshotContentLoader struct{}

func (l *noopSnapshotContentLoader) LoadContentForBootstrap(_ context.Context, _ string) (string, error) {
	return "", nil
}

type trackingSnapshotStateStore struct {
	loadedState []byte
	loadErr     error

	saveCalls     int
	savedDocument string
	savedState    []byte
	savedContent  string
	saveErr       error
}

func (s *trackingSnapshotStateStore) LoadState(_ context.Context, _ string) ([]byte, error) {
	if s.loadErr != nil {
		return nil, s.loadErr
	}
	return s.loadedState, nil
}

func (s *trackingSnapshotStateStore) SaveState(
	_ context.Context,
	docID string,
	state []byte,
	content string,
) error {
	if s.saveErr != nil {
		return s.saveErr
	}
	s.saveCalls++
	s.savedDocument = docID
	s.savedState = state
	s.savedContent = content
	return nil
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

type trackingSnapshotTxManager struct {
	calls int
}

func (m *trackingSnapshotTxManager) ExecTx(ctx context.Context, fn repositories.TxFn) error {
	m.calls++
	return fn(ctx)
}

func newSnapshotHandlerForTest(store *snapshotTestSnapshotStore, resolver *snapshotTestResolver) *CollabSnapshotHandler {
	return NewCollabSnapshotHandler(
		&noopSnapshotStateStore{},
		store,
		&noopSnapshotContentLoader{},
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

	store := &snapshotTestSnapshotStore{
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
			h := newSnapshotHandlerForTest(&snapshotTestSnapshotStore{}, &snapshotTestResolver{allowed: true})
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

	store := &snapshotTestSnapshotStore{
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

	h := newSnapshotHandlerForTest(&snapshotTestSnapshotStore{}, &snapshotTestResolver{allowed: false})
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

	store := &snapshotTestSnapshotStore{
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

func TestRestoreSnapshot_Success(t *testing.T) {
	docID := uuid.MustParse("11111111-1111-1111-1111-111111111111").String()
	snapshotID := uuid.MustParse("22222222-2222-2222-2222-222222222222").String()
	userID := uuid.MustParse("33333333-3333-3333-3333-333333333333").String()

	currentState := buildSnapshotState(t, "current document content")
	targetState := buildSnapshotState(t, "restored from snapshot")

	stateStore := &trackingSnapshotStateStore{
		loadedState: currentState,
	}
	snapshotStore := &snapshotTestSnapshotStore{
		snapshot: &collabModels.SnapshotWithState{
			Snapshot: collabModels.Snapshot{
				ID:         snapshotID,
				DocumentID: docID,
				CreatedAt:  time.Now(),
			},
			YjsState: targetState,
		},
	}
	txManager := &trackingSnapshotTxManager{}

	h := NewCollabSnapshotHandler(
		stateStore,
		snapshotStore,
		&noopSnapshotContentLoader{},
		&snapshotTestResolver{allowed: true},
		txManager,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		&config.Config{Environment: "test"},
	)

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req = httputil.WithUserID(req, userID)
	req.SetPathValue("id", docID)
	req.SetPathValue("snapshotId", snapshotID)

	rr := httptest.NewRecorder()
	h.RestoreSnapshot(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rr.Code)
	}

	var resp struct {
		Status     string `json:"status"`
		SnapshotID string `json:"snapshot_id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Status != "restored" {
		t.Fatalf("expected status %q, got %q", "restored", resp.Status)
	}
	if resp.SnapshotID != snapshotID {
		t.Fatalf("expected snapshot_id %q, got %q", snapshotID, resp.SnapshotID)
	}

	if txManager.calls != 1 {
		t.Fatalf("expected one transaction, got %d", txManager.calls)
	}
	if snapshotStore.saveSnapshotCalls != 1 {
		t.Fatalf("expected one pre_restore snapshot save, got %d", snapshotStore.saveSnapshotCalls)
	}
	if snapshotStore.savedDocumentID != docID {
		t.Fatalf("expected pre_restore doc id %q, got %q", docID, snapshotStore.savedDocumentID)
	}
	if !bytes.Equal(snapshotStore.savedState, currentState) {
		t.Fatalf("expected pre_restore snapshot state to match current state")
	}
	if snapshotStore.savedSnapshotType != "pre_restore" {
		t.Fatalf("expected pre_restore snapshot type, got %q", snapshotStore.savedSnapshotType)
	}
	if snapshotStore.savedName == nil || *snapshotStore.savedName != "Pre-restore safety snapshot" {
		t.Fatalf("expected pre_restore snapshot name to be set")
	}
	if snapshotStore.savedCreatedBy == nil || *snapshotStore.savedCreatedBy != userID {
		t.Fatalf("expected pre_restore created_by_user_id to match request user")
	}

	if stateStore.saveCalls != 1 {
		t.Fatalf("expected one SaveState call, got %d", stateStore.saveCalls)
	}
	if stateStore.savedDocument != docID {
		t.Fatalf("expected SaveState doc id %q, got %q", docID, stateStore.savedDocument)
	}
	if !bytes.Equal(stateStore.savedState, targetState) {
		t.Fatalf("expected restored yjs_state to match target snapshot")
	}
	// Restore now extracts content from Yjs state (instead of setting it empty).
	if stateStore.savedContent != "restored from snapshot" {
		t.Fatalf("expected restore to extract content from Yjs state, got content=%q", stateStore.savedContent)
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
