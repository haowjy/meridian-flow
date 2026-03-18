package collab

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"
	"golang.org/x/sync/singleflight"
	"meridian/internal/domain"
	collabSvc "meridian/internal/domain/services/collab"
)

const (
	defaultPersistDebounce = 2 * time.Second
	persistTimeout         = 10 * time.Second
	sessionLoadTimeout     = 30 * time.Second
)

// DocumentSessionManager manages in-memory Yjs docs for active websocket sessions.
type DocumentSessionManager struct {
	mu             sync.Mutex
	sessions       map[string]*DocumentSession
	loadGroup      singleflight.Group
	stateStore     collabSvc.DocumentStateStore
	updateLogStore collabSvc.UpdateLogStore
	bookmarkStore  collabSvc.BookmarkStore
	contentLoader  collabSvc.DocumentContentLoader
	logger         *slog.Logger
}

// DocumentSession wraps a single in-memory Y.Doc lifecycle.
//
// Concurrency: refCount is guarded by DocumentSessionManager.mu (not this session's mu).
// Acquire/Release hold the manager lock when reading or writing refCount.
type DocumentSession struct {
	docID              string
	doc                *ycrdt.Doc
	stateStore         collabSvc.DocumentStateStore
	updateLogStore     collabSvc.UpdateLogStore
	contentLoader      collabSvc.DocumentContentLoader
	logger             *slog.Logger
	lastPersistedSV    []byte
	lastMutationOrigin string // "human" | "ai_accept" | ...

	mu            sync.Mutex
	refCount      int
	dirty         bool
	debounceTimer *time.Timer
}

// NewDocumentSessionManager creates the collab document runtime cache.
// contentLoader is separated from persistence stores (ISP) — only session bootstrap needs it.
func NewDocumentSessionManager(
	stateStore collabSvc.DocumentStateStore,
	updateLogStore collabSvc.UpdateLogStore,
	bookmarkStore collabSvc.BookmarkStore,
	contentLoader collabSvc.DocumentContentLoader,
	logger *slog.Logger,
) *DocumentSessionManager {
	return &DocumentSessionManager{
		sessions:       make(map[string]*DocumentSession),
		stateStore:     stateStore,
		updateLogStore: updateLogStore,
		bookmarkStore:  bookmarkStore,
		contentLoader:  contentLoader,
		logger:         logger,
	}
}

// Acquire returns a live document session, creating and loading it on first connect.
func (m *DocumentSessionManager) Acquire(ctx context.Context, docID string) (*DocumentSession, error) {
	m.mu.Lock()
	if existing, ok := m.sessions[docID]; ok {
		existing.refCount++
		m.mu.Unlock()
		return existing, nil
	}
	m.mu.Unlock()

	loadedSessionAny, err, _ := m.loadGroup.Do(docID, func() (interface{}, error) {
		// Detached context keeps the shared load alive even if the triggering request is canceled.
		loadCtx, cancel := context.WithTimeout(context.Background(), sessionLoadTimeout)
		defer cancel()

		session := &DocumentSession{
			docID:          docID,
			doc:            ycrdt.NewDoc(docID, true, ycrdt.DefaultGCFilter, nil, false),
			stateStore:     m.stateStore,
			updateLogStore: m.updateLogStore,
			contentLoader:  m.contentLoader,
			logger:         m.logger,
		}

		if err := session.loadState(loadCtx); err != nil {
			return nil, err
		}
		return session, nil
	})
	if err != nil {
		return nil, err
	}

	loadedSession, ok := loadedSessionAny.(*DocumentSession)
	if !ok {
		return nil, fmt.Errorf("load session returned unexpected type %T", loadedSessionAny)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.sessions[docID]; ok {
		existing.refCount++
		return existing, nil
	}

	loadedSession.refCount = 1
	m.sessions[docID] = loadedSession
	return loadedSession, nil
}

// Release decrements references and flushes state when the last websocket disconnects.
func (m *DocumentSessionManager) Release(ctx context.Context, docID string) error {
	m.mu.Lock()
	session, ok := m.sessions[docID]
	if !ok {
		m.mu.Unlock()
		return nil
	}

	if session.refCount == 0 {
		m.logger.Warn("collab session release underflow", "document_id", docID)
		m.mu.Unlock()
		return nil
	}

	session.refCount--
	if session.refCount > 0 {
		m.mu.Unlock()
		return nil
	}
	delete(m.sessions, docID)
	m.mu.Unlock()

	flushCtx, cancel := context.WithTimeout(ctx, persistTimeout)
	defer cancel()

	if err := session.flushOnDisconnect(flushCtx); err != nil {
		return err
	}

	return nil
}

func (m *DocumentSessionManager) releaseSessionRef(ctx context.Context, docID string, session *DocumentSession) error {
	m.mu.Lock()
	if session.refCount == 0 {
		m.logger.Warn("collab session ref underflow", "document_id", docID)
		m.mu.Unlock()
		return nil
	}

	session.refCount--
	if session.refCount > 0 {
		m.mu.Unlock()
		return nil
	}

	delete(m.sessions, docID)
	m.mu.Unlock()

	flushCtx, cancel := context.WithTimeout(ctx, persistTimeout)
	defer cancel()

	if err := session.flushOnDisconnect(flushCtx); err != nil {
		return err
	}
	return nil
}

// ApplyUpdate applies a proposal update to the active in-memory Y.Doc for a document.
// If an active session exists, the update is applied to the live doc. Otherwise, it falls
// back to loading persisted state, applying offline, and saving back — so auto-accepted
// proposals work even when no editor has the document open.
func (m *DocumentSessionManager) ApplyUpdate(ctx context.Context, documentID uuid.UUID, update []byte, origin string) error {
	docID := documentID.String()

	m.mu.Lock()
	session, ok := m.sessions[docID]
	if ok {
		session.refCount++
	}
	m.mu.Unlock()

	if ok {
		err := session.applyUpdate(ctx, update, origin)
		releaseErr := m.releaseSessionRef(ctx, docID, session)
		if err != nil {
			return err
		}
		return releaseErr
	}

	// No active session — apply directly to persisted state so the update isn't lost.
	// This happens when AI edits are auto-accepted while no editor has the document open.
	m.logger.Info("applying update offline (no active session)", "document_id", docID, "origin", origin)
	return m.applyUpdateOffline(ctx, docID, update, origin)
}

// applyUpdateOffline loads persisted state, applies update, appends the delta,
// and refreshes derived text projections. This keeps offline AI applies durable
// without requiring an active websocket owner tab.
func (m *DocumentSessionManager) applyUpdateOffline(ctx context.Context, docID string, update []byte, origin string) error {
	state, err := m.stateStore.LoadState(ctx, docID)
	if err != nil {
		return fmt.Errorf("load state for offline apply: %w", err)
	}

	doc := ycrdt.NewDoc(docID, true, ycrdt.DefaultGCFilter, nil, false)
	if len(state) > 0 {
		if err := safeApplyUpdate(doc, state, nil); err != nil {
			return fmt.Errorf("apply existing state for offline apply: %w", err)
		}
	}

	if err := safeApplyUpdate(doc, update, origin); err != nil {
		return fmt.Errorf("apply proposal update offline: %w", err)
	}

	content := ""
	if yText := doc.GetText("content"); yText != nil {
		content = yText.ToString()
	}

	if _, err := m.updateLogStore.AppendUpdate(ctx, docID, update, origin, nil); err != nil {
		return fmt.Errorf("append offline update: %w", err)
	}

	newState, err := safeEncodeStateAsUpdate(doc)
	if err != nil {
		return fmt.Errorf("encode state after offline apply: %w", err)
	}

	// Keep content and ai_content aligned for offline applies during migration.
	if err := m.stateStore.SaveState(ctx, docID, newState, content, content); err != nil {
		return fmt.Errorf("save state after offline apply: %w", err)
	}

	return nil
}

// CreateAITurnBookmark pins the latest update row for a turn before AI proposals apply.
// This powers turn-level restore (phase 5b).
func (m *DocumentSessionManager) CreateAITurnBookmark(
	ctx context.Context,
	documentID uuid.UUID,
	turnID uuid.UUID,
) error {
	docID := documentID.String()

	m.mu.Lock()
	session := m.sessions[docID]
	m.mu.Unlock()

	// Flush pending local changes so bookmark points to the latest committed update.
	if session != nil {
		session.mu.Lock()
		if session.dirty {
			if err := session.persistLocked(ctx); err != nil {
				session.mu.Unlock()
				return fmt.Errorf("flush dirty session before ai_turn bookmark: %w", err)
			}
		}
		session.mu.Unlock()
	}

	latestUpdateID, err := m.updateLogStore.GetLatestUpdateID(ctx, docID)
	if err != nil {
		// Migrated or freshly-created documents may have checkpoint data but no
		// update rows yet.  Use update_id=0 (i.e. "at checkpoint baseline") so
		// the bookmark can still be created.
		if errors.Is(err, domain.ErrNotFound) {
			latestUpdateID = 0
		} else {
			return fmt.Errorf("get latest update id for ai_turn bookmark: %w", err)
		}
	}

	turnIDStr := turnID.String()
	bookmark := &collabSvc.Bookmark{
		DocumentID:   docID,
		UpdateID:     &latestUpdateID,
		BookmarkType: "ai_turn",
		TurnID:       &turnIDStr,
	}

	if err := m.bookmarkStore.Create(ctx, bookmark); err != nil {
		return fmt.Errorf("create ai_turn bookmark: %w", err)
	}

	return nil
}

// GetStateSnapshot returns encoded Yjs state for an active in-memory session.
// If no active session exists, found=false and caller should fall back to persisted state.
func (m *DocumentSessionManager) GetStateSnapshot(ctx context.Context, documentID uuid.UUID) ([]byte, bool, error) {
	docID := documentID.String()

	m.mu.Lock()
	session, ok := m.sessions[docID]
	if ok {
		session.refCount++
	}
	m.mu.Unlock()
	if !ok {
		return nil, false, nil
	}

	session.mu.Lock()
	state, err := safeEncodeStateAsUpdate(session.doc)
	session.mu.Unlock()

	releaseErr := m.releaseSessionRef(ctx, docID, session)
	if err != nil {
		return nil, true, fmt.Errorf("encode in-memory state: %w", err)
	}
	if releaseErr != nil {
		return nil, true, releaseErr
	}

	return state, true, nil
}

// GetCurrentState returns the current Yjs state for a document. Unlike GetStateSnapshot,
// this always returns state — from the active in-memory session if one exists, otherwise
// by loading from persisted storage. Used by GroupAccept to compose updates safely.
func (m *DocumentSessionManager) GetCurrentState(ctx context.Context, documentID uuid.UUID) ([]byte, error) {
	// Try active session first (same as GetStateSnapshot)
	state, found, err := m.GetStateSnapshot(ctx, documentID)
	if err != nil {
		return nil, err
	}
	if found {
		return state, nil
	}
	// Fall back to persisted state
	docID := documentID.String()
	return m.stateStore.LoadState(ctx, docID)
}

// BuildSyncStep1Payload creates a sync-step1 message from current in-memory state.
func (s *DocumentSession) BuildSyncStep1Payload() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	encoder := ycrdt.NewUpdateEncoderV1()
	ycrdt.WriteSyncStep1(encoder, s.doc)
	return encoder.ToUint8Array(), nil
}

// HandleSyncPayload applies a sync payload and returns protocol-specific response/update artifacts.
func (s *DocumentSession) HandleSyncPayload(ctx context.Context, payload []byte, transactionOrigin string) (int, []byte, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	decoder := ycrdt.NewUpdateDecoderV1(payload)
	responseEncoder := ycrdt.NewUpdateEncoderV1()
	messageType, err := safeReadSyncMessage(decoder, responseEncoder, s.doc, transactionOrigin)
	if err != nil {
		return 0, nil, nil, err
	}

	responsePayload := responseEncoder.ToUint8Array()

	var updatePayload []byte
	switch messageType {
	case ycrdt.MessageYjsSyncStep2, ycrdt.MessageYjsUpdate:
		updatePayload, err = extractUpdatePayload(payload)
		if err != nil {
			return 0, nil, nil, err
		}

		// Mark origin as human since this came from user sync.
		s.lastMutationOrigin = "human"
		if err := s.markDirtyLocked(ctx); err != nil {
			return 0, nil, nil, err
		}
	}

	return messageType, responsePayload, updatePayload, nil
}

func (s *DocumentSession) applyUpdate(ctx context.Context, update []byte, origin string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := safeApplyUpdate(s.doc, update, origin); err != nil {
		return fmt.Errorf("apply yjs update: %w", err)
	}

	// Mark origin as AI accept since this is a proposal runtime update.
	s.lastMutationOrigin = "ai_accept"
	if err := s.markDirtyLocked(ctx); err != nil {
		return err
	}
	return nil
}

func (s *DocumentSession) loadState(ctx context.Context) error {
	state, err := s.stateStore.LoadState(ctx, s.docID)
	if err != nil {
		return err
	}
	if len(state) > 0 {
		s.mu.Lock()
		defer s.mu.Unlock()

		if err := safeApplyUpdate(s.doc, state, nil); err != nil {
			return fmt.Errorf("apply persisted yjs state from checkpoint+replay: %w", err)
		}
		if err := s.refreshPersistedStateVectorLocked(); err != nil {
			return err
		}
		return nil
	}

	bootstrapContent, err := s.contentLoader.LoadContentForBootstrap(ctx, s.docID)
	if err != nil {
		return fmt.Errorf("load bootstrap content: %w", err)
	}
	if bootstrapContent == "" {
		s.mu.Lock()
		defer s.mu.Unlock()

		if err := s.refreshPersistedStateVectorLocked(); err != nil {
			return err
		}
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	yText := s.doc.GetText("content")
	if yText == nil {
		if err := s.refreshPersistedStateVectorLocked(); err != nil {
			return err
		}
		return nil
	}
	s.doc.Transact(func(_ *ycrdt.Transaction) {
		if yText.Length() == 0 {
			yText.Insert(0, bootstrapContent, nil)
		}
	}, "server-bootstrap")

	persistedState, content, err := s.currentStateLocked()
	if err != nil {
		return err
	}

	// Keep content and ai_content aligned with the bootstrap state.
	if err := s.stateStore.SaveState(ctx, s.docID, persistedState, content, content); err != nil {
		return fmt.Errorf("persist bootstrapped yjs state: %w", err)
	}
	// Bootstrap row becomes the first append-only update for this document.
	if _, err := s.updateLogStore.AppendUpdate(ctx, s.docID, persistedState, "server-bootstrap", nil); err != nil {
		return fmt.Errorf("append bootstrapped yjs state: %w", err)
	}
	if err := s.refreshPersistedStateVectorLocked(); err != nil {
		return err
	}

	return nil
}

func (s *DocumentSession) flushOnDisconnect(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.debounceTimer != nil {
		s.debounceTimer.Stop()
		s.debounceTimer = nil
	}

	if !s.dirty {
		return nil
	}

	if err := s.persistLocked(ctx); err != nil {
		return err
	}

	return nil
}

func (s *DocumentSession) markDirtyLocked(ctx context.Context) error {
	s.dirty = true

	if s.debounceTimer == nil {
		s.debounceTimer = time.AfterFunc(defaultPersistDebounce, s.runDebouncePersist)
	} else {
		s.debounceTimer.Reset(defaultPersistDebounce)
	}

	return nil
}

func (s *DocumentSession) runDebouncePersist() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.dirty {
		return
	}

	// Uses context.Background() because this fires asynchronously from a timer,
	// after the original request context has completed.
	ctx, cancel := context.WithTimeout(context.Background(), persistTimeout)
	defer cancel()

	if err := s.persistLocked(ctx); err != nil {
		s.logger.Error("collab debounce persist failed",
			"document_id", s.docID,
			"error", err,
		)
	}
}

func (s *DocumentSession) persistLocked(ctx context.Context) error {
	state, content, err := s.currentStateLocked()
	if err != nil {
		return err
	}

	updateDelta, err := s.computeStateDeltaLocked()
	if err != nil {
		return err
	}

	if len(updateDelta) > 0 {
		origin := s.lastMutationOrigin
		if origin == "" {
			origin = "human"
		}
		if _, err := s.updateLogStore.AppendUpdate(ctx, s.docID, updateDelta, origin, nil); err != nil {
			return err
		}
		if err := s.refreshPersistedStateVectorLocked(); err != nil {
			return err
		}
	}

	// Keep content + ai_content aligned during migration.
	if err := s.stateStore.SaveState(ctx, s.docID, state, content, content); err != nil {
		return err
	}

	s.dirty = false

	// Stop any pending debounce timer since we just persisted. The next update
	// will create a fresh timer. Without this, a stale timer could fire and
	// persist redundantly (harmless since dirty=false, but wasteful).
	if s.debounceTimer != nil {
		s.debounceTimer.Stop()
		s.debounceTimer = nil
	}

	return nil
}

func (s *DocumentSession) currentStateLocked() ([]byte, string, error) {
	state, err := safeEncodeStateAsUpdate(s.doc)
	if err != nil {
		return nil, "", err
	}

	// GetText normalizes placeholder AbstractType entries into concrete YText.
	// Reading doc.Share directly can miss valid content after ApplyUpdate.
	content := ""
	if yText := s.doc.GetText("content"); yText != nil {
		content = yText.ToString()
	}

	return state, content, nil
}

func (s *DocumentSession) computeStateDeltaLocked() ([]byte, error) {
	if len(s.lastPersistedSV) == 0 {
		return safeEncodeStateAsUpdate(s.doc)
	}
	return safeEncodeStateAsUpdateFromStateVector(s.doc, s.lastPersistedSV)
}

func (s *DocumentSession) refreshPersistedStateVectorLocked() error {
	stateVector, err := safeEncodeStateVector(s.doc)
	if err != nil {
		return err
	}
	s.lastPersistedSV = stateVector
	return nil
}

func extractUpdatePayload(syncPayload []byte) ([]byte, error) {
	decoder := ycrdt.NewUpdateDecoderV1(syncPayload)
	msgType := ycrdt.ReadVarUint(decoder.RestDecoder)
	if msgType != ycrdt.MessageYjsSyncStep2 && msgType != ycrdt.MessageYjsUpdate {
		return nil, fmt.Errorf("sync payload is not an update message: type=%d", msgType)
	}

	dataAny, err := ycrdt.ReadVarUint8Array(decoder.RestDecoder)
	if err != nil {
		return nil, fmt.Errorf("decode update payload: %w", err)
	}

	update, ok := dataAny.([]byte)
	if !ok {
		return nil, fmt.Errorf("decode update payload: unexpected payload type %T", dataAny)
	}

	return update, nil
}

// safeReadSyncMessage wraps ycrdt.ReadSyncMessage with panic recovery.
// Known panic triggers: nil decoder/encoder, nil doc, malformed sync payload.
// Panics map to RESET_REQUIRED at the handler layer.
func safeReadSyncMessage(
	decoder *ycrdt.UpdateDecoderV1,
	encoder *ycrdt.UpdateEncoderV1,
	doc *ycrdt.Doc,
	origin interface{},
) (messageType int, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("read sync message panic: %v", r)
		}
	}()

	messageType = ycrdt.ReadSyncMessage(decoder, encoder, doc, origin)
	return messageType, nil
}

// safeApplyUpdate wraps ycrdt.ApplyUpdate with panic recovery.
// Known panic triggers: nil doc, malformed/truncated update bytes, nil internal structures.
// Panics map to RESET_REQUIRED at the handler layer.
func safeApplyUpdate(doc *ycrdt.Doc, update []byte, origin interface{}) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("apply update panic: %v", r)
		}
	}()

	ycrdt.ApplyUpdate(doc, update, origin)
	return nil
}

// safeEncodeStateAsUpdate wraps ycrdt.EncodeStateAsUpdate with panic recovery.
// Known panic triggers: nil doc, corrupted internal doc state.
// Panics map to RESET_REQUIRED at the handler layer.
func safeEncodeStateAsUpdate(doc *ycrdt.Doc) (state []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("encode state panic: %v", r)
		}
	}()

	state = ycrdt.EncodeStateAsUpdate(doc, nil)
	return state, nil
}

// safeEncodeStateVector wraps ycrdt.EncodeStateVector with panic recovery.
func safeEncodeStateVector(doc *ycrdt.Doc) (stateVector []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("encode state vector panic: %v", r)
		}
	}()

	stateVector = ycrdt.EncodeStateVector(doc, nil, ycrdt.NewUpdateEncoderV1())
	return stateVector, nil
}

// safeEncodeStateAsUpdateFromStateVector encodes the delta relative to a prior state vector.
func safeEncodeStateAsUpdateFromStateVector(doc *ycrdt.Doc, stateVector []byte) (state []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("encode state delta panic: %v", r)
		}
	}()

	state = ycrdt.EncodeStateAsUpdate(doc, stateVector)
	return state, nil
}
