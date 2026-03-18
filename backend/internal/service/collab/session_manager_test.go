package collab

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"
	collabSvc "meridian/internal/domain/services/collab"
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

func TestDocumentSessionLoadState_BootstrapsFromContentWhenStateEmpty(t *testing.T) {
	store := &fakeSessionStore{
		state:            []byte{},
		bootstrapContent: "seed text",
	}
	session := &DocumentSession{
		docID:          "doc-bootstrap",
		doc:            ycrdt.NewDoc("doc-bootstrap", true, ycrdt.DefaultGCFilter, nil, false),
		stateStore:     store,
		updateLogStore: &fakeSessionUpdateLogStore{},
		contentLoader:  store,
	}

	if err := session.loadState(context.Background()); err != nil {
		t.Fatalf("loadState returned error: %v", err)
	}

	if got := readSessionContent(session.doc); got != "seed text" {
		t.Fatalf("expected bootstrapped content %q, got %q", "seed text", got)
	}
	if store.loadContentCalls != 1 {
		t.Fatalf("expected one LoadContentForBootstrap call, got %d", store.loadContentCalls)
	}
	if store.saveCalls != 1 {
		t.Fatalf("expected one SaveState call for bootstrap persist, got %d", store.saveCalls)
	}
	if store.savedContent != "seed text" {
		t.Fatalf("expected persisted content %q, got %q", "seed text", store.savedContent)
	}
	if got := decodeStateContent(t, store.savedState); got != "seed text" {
		t.Fatalf("expected persisted yjs_state content %q, got %q", "seed text", got)
	}
}

func TestDocumentSessionLoadState_EmptyStateAndEmptyContentNoop(t *testing.T) {
	store := &fakeSessionStore{
		state:            []byte{},
		bootstrapContent: "",
	}
	session := &DocumentSession{
		docID:          "doc-empty",
		doc:            ycrdt.NewDoc("doc-empty", true, ycrdt.DefaultGCFilter, nil, false),
		stateStore:     store,
		updateLogStore: &fakeSessionUpdateLogStore{},
		contentLoader:  store,
	}

	if err := session.loadState(context.Background()); err != nil {
		t.Fatalf("loadState returned error: %v", err)
	}

	if got := readSessionContent(session.doc); got != "" {
		t.Fatalf("expected empty content, got %q", got)
	}
	if store.loadContentCalls != 1 {
		t.Fatalf("expected one LoadContentForBootstrap call, got %d", store.loadContentCalls)
	}
	if store.saveCalls != 1 {
		t.Fatalf("expected one SaveState call to persist _proposal_status bootstrap, got %d", store.saveCalls)
	}
}

func TestDocumentSessionLoadState_ExistingStateSkipsBootstrapPath(t *testing.T) {
	existingState := mustBuildSessionState(t, "persisted")
	store := &fakeSessionStore{
		state:            existingState,
		bootstrapContent: "should-not-load",
	}
	session := &DocumentSession{
		docID:          "doc-existing",
		doc:            ycrdt.NewDoc("doc-existing", true, ycrdt.DefaultGCFilter, nil, false),
		stateStore:     store,
		updateLogStore: &fakeSessionUpdateLogStore{},
		contentLoader:  store,
	}

	if err := session.loadState(context.Background()); err != nil {
		t.Fatalf("loadState returned error: %v", err)
	}

	if got := readSessionContent(session.doc); got != "persisted" {
		t.Fatalf("expected persisted content %q, got %q", "persisted", got)
	}
	if store.loadContentCalls != 0 {
		t.Fatalf("expected bootstrap content not to be loaded, got %d calls", store.loadContentCalls)
	}
	if store.saveCalls != 1 {
		t.Fatalf("expected one SaveState call to persist _proposal_status bootstrap, got %d", store.saveCalls)
	}
}

func TestDocumentSessionManagerApplyUpdate_OfflinePersistsContent(t *testing.T) {
	expectedContent := "offline ai apply content"
	update := mustBuildSessionState(t, expectedContent)
	store := &fakeSessionStore{state: []byte{}}
	updateLogStore := &fakeSessionUpdateLogStore{}
	bookmarkStore := &fakeSessionBookmarkStore{}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager := NewDocumentSessionManager(store, updateLogStore, bookmarkStore, nil, store, logger)

	if err := manager.ApplyUpdate(context.Background(), uuid.New(), update, "ai_accept"); err != nil {
		t.Fatalf("ApplyUpdate returned error: %v", err)
	}

	if store.saveCalls != 1 {
		t.Fatalf("expected one SaveState call, got %d", store.saveCalls)
	}
	if store.savedContent != expectedContent {
		t.Fatalf("expected saved content %q, got %q", expectedContent, store.savedContent)
	}
	if updateLogStore.appendCalls != 1 {
		t.Fatalf("expected one AppendUpdate call, got %d", updateLogStore.appendCalls)
	}
	if string(updateLogStore.lastUpdate) != string(update) {
		t.Fatal("expected appended update to match offline apply update payload")
	}
	if got := decodeStateContent(t, store.savedState); got != expectedContent {
		t.Fatalf("expected persisted state content %q, got %q", expectedContent, got)
	}
}

func TestDocumentSessionLoadState_ReconcilesProposalStatusMap(t *testing.T) {
	docID := "doc-reconcile"
	proposalID := uuid.New().String()
	store := &fakeSessionStore{
		state: mustBuildSessionStateWithStatusMap(t, "seed text", map[string]string{
			proposalID: "accepted",
		}),
	}
	statusMirror := &fakeSessionStatusMirror{}
	session := &DocumentSession{
		docID:          docID,
		doc:            ycrdt.NewDoc(docID, true, ycrdt.DefaultGCFilter, nil, false),
		stateStore:     store,
		updateLogStore: &fakeSessionUpdateLogStore{},
		statusMirror:   statusMirror,
		contentLoader:  store,
		logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	if err := session.loadState(context.Background()); err != nil {
		t.Fatalf("loadState returned error: %v", err)
	}

	statusMirror.mu.Lock()
	defer statusMirror.mu.Unlock()
	if statusMirror.reconcileCalls != 1 {
		t.Fatalf("expected one reconcile call, got %d", statusMirror.reconcileCalls)
	}
	if statusMirror.lastReconcileDocID != docID {
		t.Fatalf("expected reconcile doc %q, got %q", docID, statusMirror.lastReconcileDocID)
	}
	if got := statusMirror.lastStatusMap[proposalID]; got != "accepted" {
		t.Fatalf("expected reconciled status accepted for proposal %s, got %q", proposalID, got)
	}
}

func TestDocumentSessionLoadState_ObservesProposalStatusMapDeltas(t *testing.T) {
	docID := "doc-observe"
	proposalID := uuid.New().String()
	store := &fakeSessionStore{
		state: mustBuildSessionStateWithStatusMap(t, "", nil),
	}
	statusMirror := &fakeSessionStatusMirror{}
	session := &DocumentSession{
		docID:          docID,
		doc:            ycrdt.NewDoc(docID, true, ycrdt.DefaultGCFilter, nil, false),
		stateStore:     store,
		updateLogStore: &fakeSessionUpdateLogStore{},
		statusMirror:   statusMirror,
		contentLoader:  store,
		logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	if err := session.loadState(context.Background()); err != nil {
		t.Fatalf("loadState returned error: %v", err)
	}

	statusMap := session.doc.GetMap("_proposal_status").(*ycrdt.YMap)
	session.doc.Transact(func(_ *ycrdt.Transaction) {
		statusMap.Set(proposalID, "rejected")
	}, "test-status-set")
	session.doc.Transact(func(_ *ycrdt.Transaction) {
		statusMap.Delete(proposalID)
	}, "test-status-delete")

	statusMirror.mu.Lock()
	defer statusMirror.mu.Unlock()
	if len(statusMirror.changeCalls) < 2 {
		t.Fatalf("expected at least 2 status delta calls, got %d", len(statusMirror.changeCalls))
	}

	first := statusMirror.changeCalls[len(statusMirror.changeCalls)-2]
	if first.proposalID != proposalID || first.status == nil || *first.status != "rejected" {
		t.Fatalf("unexpected set delta call: %+v", first)
	}
	second := statusMirror.changeCalls[len(statusMirror.changeCalls)-1]
	if second.proposalID != proposalID || second.status != nil {
		t.Fatalf("unexpected delete delta call: %+v", second)
	}
}

func TestDocumentSessionManagerFreezeAndRebuild(t *testing.T) {
	docID := uuid.New().String()
	store := &fakeSessionStore{
		state: mustBuildSessionStateWithStatusMap(t, "seed", nil),
	}
	updateLogStore := &fakeSessionUpdateLogStore{}
	manager := NewDocumentSessionManager(
		store,
		updateLogStore,
		&fakeSessionBookmarkStore{},
		nil,
		store,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)

	originalSession, err := manager.Acquire(context.Background(), docID)
	if err != nil {
		t.Fatalf("Acquire returned error: %v", err)
	}

	if err := manager.Freeze(context.Background(), docID); err != nil {
		t.Fatalf("Freeze returned error: %v", err)
	}

	if _, err := manager.Acquire(context.Background(), docID); !errors.Is(err, errSessionFrozen) {
		t.Fatalf("expected frozen acquire error, got %v", err)
	}

	if err := manager.Rebuild(context.Background(), docID); err != nil {
		t.Fatalf("Rebuild returned error: %v", err)
	}

	rebuiltSession, err := manager.Acquire(context.Background(), docID)
	if err != nil {
		t.Fatalf("Acquire after rebuild returned error: %v", err)
	}
	if rebuiltSession == originalSession {
		t.Fatalf("expected rebuilt session pointer to differ from original")
	}
}

type fakeSessionStore struct {
	state            []byte
	bootstrapContent string

	loadContentCalls int
	saveCalls        int

	savedState   []byte
	savedContent string
}

func (s *fakeSessionStore) LoadState(_ context.Context, _ string) ([]byte, error) {
	return s.state, nil
}

func (s *fakeSessionStore) LoadContentForBootstrap(_ context.Context, _ string) (string, error) {
	s.loadContentCalls++
	return s.bootstrapContent, nil
}

func (s *fakeSessionStore) SaveState(
	_ context.Context,
	_ string,
	state []byte,
	content string,
) error {
	s.saveCalls++
	s.savedState = state
	s.savedContent = content
	return nil
}

type fakeSessionUpdateLogStore struct {
	appendCalls int
	lastUpdate  []byte
}

func (s *fakeSessionUpdateLogStore) AppendUpdate(_ context.Context, _ string, update []byte, _ string, _ *string) (int64, error) {
	s.appendCalls++
	s.lastUpdate = update
	return int64(s.appendCalls), nil
}

func (s *fakeSessionUpdateLogStore) LoadSinceCheckpoint(_ context.Context, _ string) ([]byte, [][]byte, error) {
	return nil, nil, nil
}

func (s *fakeSessionUpdateLogStore) CountUpdates(_ context.Context, _ string) (int64, error) {
	return 0, nil
}

func (s *fakeSessionUpdateLogStore) DeleteUpTo(_ context.Context, _ string, _ int64) error {
	return nil
}

func (s *fakeSessionUpdateLogStore) GetLatestUpdateID(_ context.Context, _ string) (int64, error) {
	return 0, nil
}

func (s *fakeSessionUpdateLogStore) ListDocumentsWithMinUpdates(_ context.Context, _ int64) ([]string, error) {
	return nil, nil
}

func (s *fakeSessionUpdateLogStore) GetNthOldestUpdateID(_ context.Context, _ string, _ int64) (int64, error) {
	return 0, nil
}

func (s *fakeSessionUpdateLogStore) ListUpdatesInRange(_ context.Context, _ string, _, _ int64) ([]collabSvc.UpdateLogEntry, error) {
	return nil, nil
}

func (s *fakeSessionUpdateLogStore) AcquireCompactionLock(_ context.Context, _ string) error {
	return nil
}

type fakeSessionBookmarkStore struct{}

func (s *fakeSessionBookmarkStore) Create(_ context.Context, _ *collabSvc.Bookmark) error {
	return nil
}

func (s *fakeSessionBookmarkStore) ListByDocumentAndType(_ context.Context, _, _ string) ([]collabSvc.Bookmark, error) {
	return nil, nil
}

func (s *fakeSessionBookmarkStore) ListByTurnID(_ context.Context, _ string) ([]collabSvc.Bookmark, error) {
	return nil, nil
}

func (s *fakeSessionBookmarkStore) GetState(_ context.Context, _ string) ([]byte, error) {
	return nil, nil
}

func (s *fakeSessionBookmarkStore) MaterializeState(_ context.Context, _ string, _ []byte) error {
	return nil
}

func (s *fakeSessionBookmarkStore) DeleteByTypeAndCutoff(_ context.Context, _, _ string, _ int64) error {
	return nil
}

func mustBuildSessionState(t *testing.T, content string) []byte {
	t.Helper()
	doc := ycrdt.NewDoc("session-state", true, ycrdt.DefaultGCFilter, nil, false)
	yText := doc.GetText("content")
	doc.Transact(func(_ *ycrdt.Transaction) {
		yText.Insert(0, content, nil)
	}, nil)
	return ycrdt.EncodeStateAsUpdate(doc, nil)
}

func mustBuildSessionStateWithStatusMap(t *testing.T, content string, status map[string]string) []byte {
	t.Helper()
	doc := ycrdt.NewDoc("session-state-with-map", true, ycrdt.DefaultGCFilter, nil, false)
	yText := doc.GetText("content")
	statusMap := doc.GetMap("_proposal_status").(*ycrdt.YMap)
	doc.Transact(func(_ *ycrdt.Transaction) {
		if content != "" {
			yText.Insert(0, content, nil)
		}
		for proposalID, proposalStatus := range status {
			statusMap.Set(proposalID, proposalStatus)
		}
	}, nil)
	return ycrdt.EncodeStateAsUpdate(doc, nil)
}

func decodeStateContent(t *testing.T, state []byte) string {
	t.Helper()
	doc := ycrdt.NewDoc("decode-session-state", true, ycrdt.DefaultGCFilter, nil, false)
	if len(state) > 0 {
		if err := safeApplyUpdate(doc, state, "decode"); err != nil {
			t.Fatalf("apply state: %v", err)
		}
	}
	return readSessionContent(doc)
}

func readSessionContent(doc *ycrdt.Doc) string {
	text := doc.GetText("content")
	if text == nil {
		return ""
	}
	return text.ToString()
}

type fakeSessionStatusMirror struct {
	mu                 sync.Mutex
	reconcileCalls     int
	lastReconcileDocID string
	lastStatusMap      map[string]string
	changeCalls        []statusMirrorChangeCall
}

type statusMirrorChangeCall struct {
	proposalID string
	status     *string
}

func (f *fakeSessionStatusMirror) OnStatusChange(_ context.Context, proposalID string, newStatus *string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	var statusCopy *string
	if newStatus != nil {
		value := *newStatus
		statusCopy = &value
	}
	f.changeCalls = append(f.changeCalls, statusMirrorChangeCall{
		proposalID: proposalID,
		status:     statusCopy,
	})
	return nil
}

func (f *fakeSessionStatusMirror) ReconcileAll(_ context.Context, documentID string, statusMap map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.reconcileCalls++
	f.lastReconcileDocID = documentID
	f.lastStatusMap = make(map[string]string, len(statusMap))
	for key, value := range statusMap {
		f.lastStatusMap[key] = value
	}
	return nil
}
