package collab

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/google/uuid"

	"meridian/internal/domain"
	"meridian/internal/domain/repositories"
	"meridian/internal/domain/services"
	collabSvc "meridian/internal/domain/services/collab"
)

const testRestoreUserID = "user-123"

func TestRestoreServiceRestoreTurn_EnforcesAuthorization(t *testing.T) {
	svc := NewRestoreService(
		&fakeRestoreBookmarkStore{},
		&fakeRestoreStateStore{},
		&fakeRestoreCheckpointStore{},
		&fakeRestoreUpdateLogStore{},
		&fakeRestoreStatusMirror{},
		&fakeRestoreSessionManager{},
		&fakeRestoreBroadcaster{},
		&fakeRestoreTxManager{},
		&fakeRestoreAuthorizer{err: domain.NewForbiddenError("access denied")},
		nil,
	)

	_, err := svc.RestoreTurn(context.Background(), testRestoreUserID, uuid.New())
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("expected forbidden error, got %v", err)
	}
}

func TestRestoreServiceRestoreTurn_NotFound(t *testing.T) {
	turnID := uuid.New()
	svc := NewRestoreService(
		&fakeRestoreBookmarkStore{},
		&fakeRestoreStateStore{},
		&fakeRestoreCheckpointStore{},
		&fakeRestoreUpdateLogStore{},
		&fakeRestoreStatusMirror{},
		&fakeRestoreSessionManager{},
		&fakeRestoreBroadcaster{},
		&fakeRestoreTxManager{},
		&fakeRestoreAuthorizer{},
		nil,
	)

	_, err := svc.RestoreTurn(context.Background(), testRestoreUserID, turnID)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("expected not found error, got %v", err)
	}
}

func TestRestoreServiceRestoreTurn_CreatesSafetyBookmarksRestoresStateAndReconciles(t *testing.T) {
	turnID := uuid.New()
	turnIDStr := turnID.String()
	docID := uuid.New()
	docIDStr := docID.String()
	proposalID := uuid.New().String()

	bookmarkID := "bookmark-ai-turn-1"
	restoreState := mustBuildSessionStateWithStatusMap(t, "before turn", map[string]string{
		proposalID: "pending",
	})
	currentState := mustBuildSessionStateWithStatusMap(t, "after turn", map[string]string{
		proposalID: "accepted",
	})

	bookmarkStore := &fakeRestoreBookmarkStore{
		listByTurn: []collabSvc.Bookmark{
			{
				ID:           bookmarkID,
				DocumentID:   docIDStr,
				BookmarkType: restoreBookmarkTypeAITurn,
				TurnID:       &turnIDStr,
			},
		},
		statesByBookmarkID: map[string][]byte{
			bookmarkID: restoreState,
		},
	}
	stateStore := &fakeRestoreStateStore{
		loadedStates: map[string][]byte{
			docIDStr: currentState,
		},
	}
	checkpointStore := &fakeRestoreCheckpointStore{}
	updateLogStore := &fakeRestoreUpdateLogStore{}
	statusMirror := &fakeRestoreStatusMirror{}
	sessionManager := &fakeRestoreSessionManager{}
	broadcaster := &fakeRestoreBroadcaster{}

	svc := NewRestoreService(
		bookmarkStore,
		stateStore,
		checkpointStore,
		updateLogStore,
		statusMirror,
		sessionManager,
		broadcaster,
		&fakeRestoreTxManager{},
		&fakeRestoreAuthorizer{},
		nil,
	)

	result, err := svc.RestoreTurn(context.Background(), testRestoreUserID, turnID)
	if err != nil {
		t.Fatalf("RestoreTurn returned error: %v", err)
	}
	if len(result.AffectedDocumentIDs) != 1 || result.AffectedDocumentIDs[0] != docID {
		t.Fatalf("unexpected affected ids: %+v", result.AffectedDocumentIDs)
	}

	if len(bookmarkStore.createCalls) != 1 {
		t.Fatalf("expected one safety bookmark create call, got %d", len(bookmarkStore.createCalls))
	}
	createCall := bookmarkStore.createCalls[0]
	if createCall.DocumentID != docIDStr || createCall.BookmarkType != restoreBookmarkTypeSafetyRestore {
		t.Fatalf("unexpected safety bookmark create call: %+v", createCall)
	}
	if createCall.TurnID == nil || *createCall.TurnID != turnIDStr {
		t.Fatalf("expected safety bookmark turn id %q, got %+v", turnIDStr, createCall.TurnID)
	}

	if len(updateLogStore.lockOrder) != 1 || updateLogStore.lockOrder[0] != docIDStr {
		t.Fatalf("unexpected lock order: %+v", updateLogStore.lockOrder)
	}
	if len(updateLogStore.deleteCalls) != 1 {
		t.Fatalf("expected one delete call, got %d", len(updateLogStore.deleteCalls))
	}
	if updateLogStore.deleteCalls[0].docID != docIDStr || updateLogStore.deleteCalls[0].cutoff != restoreDeleteAllUpdatesCutoff {
		t.Fatalf("unexpected delete call: %+v", updateLogStore.deleteCalls[0])
	}

	if len(checkpointStore.createCalls) != 1 {
		t.Fatalf("expected one checkpoint create call, got %d", len(checkpointStore.createCalls))
	}
	if checkpointStore.createCalls[0].docID != docIDStr || checkpointStore.createCalls[0].upToID != 0 {
		t.Fatalf("unexpected checkpoint create call: %+v", checkpointStore.createCalls[0])
	}

	if len(broadcaster.docs) != 1 || broadcaster.docs[0] != docIDStr {
		t.Fatalf("unexpected restored broadcasts: %+v", broadcaster.docs)
	}
	if !reflect.DeepEqual(sessionManager.freezeCalls, []string{docIDStr}) {
		t.Fatalf("unexpected freeze calls: %+v", sessionManager.freezeCalls)
	}
	if !reflect.DeepEqual(sessionManager.rebuildCalls, []string{docIDStr}) {
		t.Fatalf("unexpected rebuild calls: %+v", sessionManager.rebuildCalls)
	}
	if len(statusMirror.reconcileCalls) != 1 {
		t.Fatalf("expected one reconcile call, got %d", len(statusMirror.reconcileCalls))
	}
	if statusMirror.reconcileCalls[0].documentID != docIDStr {
		t.Fatalf("unexpected reconcile document id: %+v", statusMirror.reconcileCalls[0].documentID)
	}
	if statusMirror.reconcileCalls[0].statusMap[proposalID] != "pending" {
		t.Fatalf("expected reconciled proposal status pending, got %+v", statusMirror.reconcileCalls[0].statusMap)
	}

	if len(stateStore.saveCalls) != 1 {
		t.Fatalf("expected one SaveState call, got %d", len(stateStore.saveCalls))
	}
	if stateStore.saveCalls[0].docID != docIDStr || stateStore.saveCalls[0].content != "before turn" {
		t.Fatalf("unexpected SaveState call: %+v", stateStore.saveCalls[0])
	}
}

func TestRestoreServiceUndoRestore_SortsDocumentsAndSkipsSafetyBookmarkCreation(t *testing.T) {
	turnID := uuid.New()
	turnIDStr := turnID.String()
	docA := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	docB := uuid.MustParse("99999999-9999-9999-9999-999999999999")

	bookmarkStore := &fakeRestoreBookmarkStore{
		listByTurn: []collabSvc.Bookmark{
			{
				ID:           "bookmark-b",
				DocumentID:   docB.String(),
				BookmarkType: restoreBookmarkTypeSafetyRestore,
				TurnID:       &turnIDStr,
			},
			{
				ID:           "bookmark-a",
				DocumentID:   docA.String(),
				BookmarkType: restoreBookmarkTypeSafetyRestore,
				TurnID:       &turnIDStr,
			},
		},
		statesByBookmarkID: map[string][]byte{
			"bookmark-a": mustBuildSessionStateWithStatusMap(t, "a", nil),
			"bookmark-b": mustBuildSessionStateWithStatusMap(t, "b", nil),
		},
	}
	stateStore := &fakeRestoreStateStore{
		loadedStates: map[string][]byte{
			docA.String(): mustBuildSessionStateWithStatusMap(t, "current-a", nil),
			docB.String(): mustBuildSessionStateWithStatusMap(t, "current-b", nil),
		},
	}
	updateLogStore := &fakeRestoreUpdateLogStore{}
	sessionManager := &fakeRestoreSessionManager{}

	svc := NewRestoreService(
		bookmarkStore,
		stateStore,
		&fakeRestoreCheckpointStore{},
		updateLogStore,
		&fakeRestoreStatusMirror{},
		sessionManager,
		&fakeRestoreBroadcaster{},
		&fakeRestoreTxManager{},
		&fakeRestoreAuthorizer{},
		nil,
	)

	result, err := svc.UndoRestore(context.Background(), testRestoreUserID, turnID)
	if err != nil {
		t.Fatalf("UndoRestore returned error: %v", err)
	}
	if len(result.AffectedDocumentIDs) != 2 {
		t.Fatalf("expected 2 affected docs, got %d", len(result.AffectedDocumentIDs))
	}

	expectedOrder := []string{docA.String(), docB.String()}
	if !reflect.DeepEqual(updateLogStore.lockOrder, expectedOrder) {
		t.Fatalf("expected lock order %v, got %v", expectedOrder, updateLogStore.lockOrder)
	}
	if !reflect.DeepEqual(sessionManager.freezeCalls, expectedOrder) {
		t.Fatalf("expected freeze order %v, got %v", expectedOrder, sessionManager.freezeCalls)
	}
	if !reflect.DeepEqual(sessionManager.rebuildCalls, expectedOrder) {
		t.Fatalf("expected rebuild order %v, got %v", expectedOrder, sessionManager.rebuildCalls)
	}
	if len(bookmarkStore.createCalls) != 0 {
		t.Fatalf("expected no safety bookmark create calls for undo restore, got %d", len(bookmarkStore.createCalls))
	}
}

type fakeRestoreAuthorizer struct {
	err         error
	canAccesses []struct {
		userID string
		turnID string
	}
}

func (a *fakeRestoreAuthorizer) CanAccessProject(context.Context, string, string) error { return nil }
func (a *fakeRestoreAuthorizer) CanAccessFolder(context.Context, string, string) error  { return nil }
func (a *fakeRestoreAuthorizer) CanAccessDocument(context.Context, string, string) error {
	return nil
}
func (a *fakeRestoreAuthorizer) CanAccessThread(context.Context, string, string) error { return nil }
func (a *fakeRestoreAuthorizer) CanAccessTurn(_ context.Context, userID, turnID string) error {
	a.canAccesses = append(a.canAccesses, struct {
		userID string
		turnID string
	}{
		userID: userID,
		turnID: turnID,
	})
	return a.err
}

var _ services.ResourceAuthorizer = (*fakeRestoreAuthorizer)(nil)

type fakeRestoreBookmarkStore struct {
	listByTurn          []collabSvc.Bookmark
	statesByBookmarkID  map[string][]byte
	createCalls         []collabSvc.Bookmark
	dedupCreateBookmark map[string]struct{}
}

func (s *fakeRestoreBookmarkStore) Create(_ context.Context, bookmark *collabSvc.Bookmark) error {
	if s.dedupCreateBookmark == nil {
		s.dedupCreateBookmark = make(map[string]struct{})
	}
	turn := ""
	if bookmark.TurnID != nil {
		turn = *bookmark.TurnID
	}
	key := bookmark.DocumentID + "|" + turn + "|" + bookmark.BookmarkType
	if _, exists := s.dedupCreateBookmark[key]; exists {
		return nil
	}
	s.dedupCreateBookmark[key] = struct{}{}

	copy := *bookmark
	s.createCalls = append(s.createCalls, copy)
	return nil
}

func (s *fakeRestoreBookmarkStore) ListByDocumentAndType(_ context.Context, _, _ string) ([]collabSvc.Bookmark, error) {
	return nil, nil
}

func (s *fakeRestoreBookmarkStore) ListByTurnID(_ context.Context, _ string) ([]collabSvc.Bookmark, error) {
	return s.listByTurn, nil
}

func (s *fakeRestoreBookmarkStore) GetState(_ context.Context, bookmarkID string) ([]byte, error) {
	state, ok := s.statesByBookmarkID[bookmarkID]
	if !ok {
		return nil, domain.NewNotFoundError("bookmark", "bookmark state not found")
	}
	return state, nil
}

func (s *fakeRestoreBookmarkStore) MaterializeState(_ context.Context, _ string, _ []byte) error {
	return nil
}

func (s *fakeRestoreBookmarkStore) DeleteByTypeAndCutoff(_ context.Context, _, _ string, _ int64) error {
	return nil
}

type fakeRestoreStateStore struct {
	loadedStates map[string][]byte
	saveCalls    []restoreSaveCall
}

type restoreSaveCall struct {
	docID   string
	state   []byte
	content string
}

func (s *fakeRestoreStateStore) LoadState(_ context.Context, docID string) ([]byte, error) {
	state, ok := s.loadedStates[docID]
	if !ok {
		return nil, domain.NewNotFoundError("document", "state not found")
	}
	return state, nil
}

func (s *fakeRestoreStateStore) SaveState(_ context.Context, docID string, state []byte, content string) error {
	s.saveCalls = append(s.saveCalls, restoreSaveCall{
		docID:   docID,
		state:   state,
		content: content,
	})
	return nil
}

type fakeRestoreCheckpointStore struct {
	createCalls []restoreCheckpointCreateCall
}

type restoreCheckpointCreateCall struct {
	docID  string
	state  []byte
	upToID int64
}

func (s *fakeRestoreCheckpointStore) GetLatest(_ context.Context, _ string) ([]byte, int64, error) {
	return nil, 0, nil
}

func (s *fakeRestoreCheckpointStore) Create(_ context.Context, docID string, state []byte, upToID int64) error {
	s.createCalls = append(s.createCalls, restoreCheckpointCreateCall{
		docID:  docID,
		state:  state,
		upToID: upToID,
	})
	return nil
}

type fakeRestoreUpdateLogStore struct {
	lockOrder   []string
	deleteCalls []restoreDeleteCall
}

type restoreDeleteCall struct {
	docID  string
	cutoff int64
}

func (s *fakeRestoreUpdateLogStore) AppendUpdate(_ context.Context, _ string, _ []byte, _ string, _ *string) (int64, error) {
	return 0, nil
}

func (s *fakeRestoreUpdateLogStore) LoadSinceCheckpoint(_ context.Context, _ string) ([]byte, [][]byte, error) {
	return nil, nil, nil
}

func (s *fakeRestoreUpdateLogStore) CountUpdates(_ context.Context, _ string) (int64, error) {
	return 0, nil
}

func (s *fakeRestoreUpdateLogStore) DeleteUpTo(_ context.Context, docID string, cutoffID int64) error {
	s.deleteCalls = append(s.deleteCalls, restoreDeleteCall{docID: docID, cutoff: cutoffID})
	return nil
}

func (s *fakeRestoreUpdateLogStore) GetLatestUpdateID(_ context.Context, _ string) (int64, error) {
	return 0, nil
}

func (s *fakeRestoreUpdateLogStore) ListDocumentsWithMinUpdates(_ context.Context, _ int64) ([]string, error) {
	return nil, nil
}

func (s *fakeRestoreUpdateLogStore) GetNthOldestUpdateID(_ context.Context, _ string, _ int64) (int64, error) {
	return 0, nil
}

func (s *fakeRestoreUpdateLogStore) ListUpdatesInRange(_ context.Context, _ string, _ int64, _ int64) ([]collabSvc.UpdateLogEntry, error) {
	return nil, nil
}

func (s *fakeRestoreUpdateLogStore) AcquireCompactionLock(_ context.Context, docID string) error {
	s.lockOrder = append(s.lockOrder, docID)
	return nil
}

type fakeRestoreStatusMirror struct {
	reconcileCalls []restoreReconcileCall
}

type restoreReconcileCall struct {
	documentID string
	statusMap  map[string]string
}

func (s *fakeRestoreStatusMirror) OnStatusChange(_ context.Context, _ string, _ *string) error {
	return nil
}

func (s *fakeRestoreStatusMirror) ReconcileAll(_ context.Context, documentID string, statusMap map[string]string) error {
	statusCopy := make(map[string]string, len(statusMap))
	for key, value := range statusMap {
		statusCopy[key] = value
	}
	s.reconcileCalls = append(s.reconcileCalls, restoreReconcileCall{
		documentID: documentID,
		statusMap:  statusCopy,
	})
	return nil
}

type fakeRestoreSessionManager struct {
	freezeCalls  []string
	rebuildCalls []string
}

func (s *fakeRestoreSessionManager) Freeze(_ context.Context, docID string) error {
	s.freezeCalls = append(s.freezeCalls, docID)
	return nil
}

func (s *fakeRestoreSessionManager) Rebuild(_ context.Context, docID string) error {
	s.rebuildCalls = append(s.rebuildCalls, docID)
	return nil
}

type fakeRestoreBroadcaster struct {
	docs []string
}

func (s *fakeRestoreBroadcaster) BroadcastDocumentRestored(documentID string) {
	s.docs = append(s.docs, documentID)
}

type fakeRestoreTxManager struct{}

func (f *fakeRestoreTxManager) ExecTx(ctx context.Context, fn repositories.TxFn) error {
	return fn(ctx)
}
